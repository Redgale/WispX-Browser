// Subresource resolution. With a service worker, <img src="/~/sj/..."> just works because
// the SW answers the request. Without one, anything the browser loads by itself (scripts,
// stylesheets, images, fonts, module imports) has to be fetched by us through wisp and
// handed back as a blob: URL. This file owns that: a per-document cache from virtual URL to
// blob URL, CSS asset inlining, and ES module graph linking.
//
// Blob urls hold their bytes until revoked, so the cache's lifetime matters. Each document a
// tab shows gets its own Resources (a "generation"); a new one borrows whatever it can from
// the previous generation (same-site navigations reuse scripts, styles and images), and the
// previous one is released once the new document is in. Blob urls are reference counted, so
// a url survives as long as any generation still holds it.

import type { Controller, ServeResponse } from "./controller";
import { BLOB_ORIGIN } from "./env";

export type ResourceKind =
	| "script"
	| "module"
	| "style"
	| "image"
	| "font"
	| "media"
	| "object"
	| "track"
	| "fetch";

const DESTINATIONS: Record<ResourceKind, RequestDestination> = {
	script: "script",
	module: "script",
	style: "style",
	image: "image",
	font: "font",
	media: "video",
	object: "object",
	track: "track",
	fetch: "",
};

const FONT_EXT = /\.(woff2?|ttf|otf|eot)(\?|#|$)/i;
const MAX_CONCURRENT = 16;
/**
 * Images a long-lived page (an infinite feed, a SPA) keeps loading would otherwise stay in
 * memory for the life of the page. Past this many bytes, images that haven't been handed out
 * for a while are released; an <img> that already loaded one keeps showing it.
 */
const IMAGE_BUDGET = 192 * 1024 * 1024;
const IMAGE_IDLE_MS = 60_000;

const blobRefs = new Map<string, number>();
function retain(url: string) {
	blobRefs.set(url, (blobRefs.get(url) ?? 0) + 1);
}
function release(url: string) {
	const n = (blobRefs.get(url) ?? 1) - 1;
	if (n > 0) blobRefs.set(url, n);
	else {
		blobRefs.delete(url);
		URL.revokeObjectURL(url);
	}
}
/** live blob urls across all tabs (for the debug stats) */
export const liveBlobCount = () => blobRefs.size;

/** Stop a response body nobody is going to read, so its connection can be reused. */
export function discardBody(body: any) {
	try {
		if (body && typeof body.cancel === "function" && !body.locked) body.cancel().catch(() => {});
	} catch {}
}

async function bodyToBlob(body: any, type: string): Promise<Blob> {
	if (body == null) return new Blob([], { type });
	if (body instanceof Blob) return new Blob([body], { type });
	if (typeof body === "string" || body instanceof ArrayBuffer || ArrayBuffer.isView(body))
		return new Blob([body as BlobPart], { type });
	// ReadableStream or anything else Response understands. Response.blob() lets the browser
	// assemble the blob itself instead of buffering it in the JS heap first
	return new Response(body, type ? { headers: { "content-type": type } } : undefined).blob();
}

export async function bodyToText(body: any): Promise<string> {
	if (body == null) return "";
	if (typeof body === "string") return body;
	if (body instanceof ArrayBuffer || ArrayBuffer.isView(body))
		return new TextDecoder().decode(body as ArrayBuffer);
	return new Response(body).text();
}

function header(res: ServeResponse, name: string): string | null {
	name = name.toLowerCase();
	for (const [k, v] of res.headers) if (k.toLowerCase() === name) return v;
	return null;
}

function isJsType(ct: string | null) {
	if (!ct) return true;
	return /(java|ecma)script|^text\/(x-)?(jsx?|babel)|^application\/x-javascript/i.test(
		ct.split(";")[0].trim()
	);
}

function escapeRegExp(s: string) {
	return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

class Semaphore {
	private active = 0;
	private waiting: Array<() => void> = [];
	constructor(private limit: number) {}
	async run<T>(fn: () => Promise<T>): Promise<T> {
		if (this.active >= this.limit)
			await new Promise<void>((r) => this.waiting.push(r));
		this.active++;
		try {
			return await fn();
		} finally {
			this.active--;
			this.waiting.shift()?.();
		}
	}
}

export type ResolveContext = {
	clientUrl?: string;
	clientId?: string;
	/** called with virtual→blob pairs for module cycles that need an import map entry */
	importMap?: (entries: Record<string, string>) => void;
};

type Made = { url: string; bytes: number; deps?: string[] };

type Entry = {
	p: Promise<string | null>;
	settled: boolean;
	value: string | null;
	kind: ResourceKind;
	bytes: number;
	/** cache keys this entry's content points at (a stylesheet's images, fonts, imports) */
	deps?: string[];
	/** referenced from css text, which the page can apply again at any time: never evict */
	pinned: boolean;
	used: number;
};

export class Resources {
	private cache = new Map<string, Entry>();
	/** blob urls this generation holds a reference on */
	private refs = new Set<string>();
	private sem = new Semaphore(MAX_CONCURRENT);
	private cssUrlRe: RegExp;
	private moduleLitRe: RegExp;
	private closed = false;
	private imageBytes = 0;

	/** prev: the generation this one may borrow cached entries from until released */
	constructor(private ctrl: Controller, private prev: Resources | null = null) {
		const prefix = ctrl.prefix;
		// absolute virtual urls as they appear inside rewritten css / attributes
		this.cssUrlRe = new RegExp(escapeRegExp(prefix.href) + "[^\\s\"')]*", "g");
		// root-relative virtual urls as the js rewriter emits them for static imports
		this.moduleLitRe = new RegExp(
			"([\"'])(" + escapeRegExp(prefix.pathname) + "[^\"'\\\\\\n]*)\\1",
			"g"
		);
		if (prev?.closed) this.prev = null;
	}

	isVirtual(url: string) {
		return typeof url === "string" && url.startsWith(this.ctrl.prefix.href);
	}

	private hold(url: string) {
		if (this.refs.has(url)) return;
		this.refs.add(url);
		retain(url);
	}

	private drop(url: string) {
		if (this.refs.delete(url)) release(url);
	}

	/** Take ownership of a blob url created elsewhere (released with this generation). */
	own(url: string) {
		if (this.closed) URL.revokeObjectURL(url);
		else this.hold(url);
	}

	private async makeBlob(blob: Blob): Promise<Made | null> {
		if (this.closed) return null;
		const url = URL.createObjectURL(blob);
		this.hold(url);
		return { url, bytes: blob.size };
	}

	/** Stop borrowing from the previous generation (it's about to be released). */
	detach() {
		this.prev = null;
	}

	/** Release every blob this generation holds. Only safe once no document uses them. */
	clear() {
		this.closed = true;
		this.prev = null;
		for (const url of this.refs) release(url);
		this.refs.clear();
		this.cache.clear();
		this.imageBytes = 0;
	}

	get stats() {
		return { entries: this.cache.size, blobs: this.refs.size, imageBytes: this.imageBytes };
	}

	private key(kind: ResourceKind, virtual: string) {
		// module identity must not depend on which query flags the rewriter attached,
		// otherwise a static import and a dynamic import() of the same file would
		// instantiate twice
		const real = this.ctrl.unrewrite(virtual.split("#")[0]);
		const k = kind === "module" ? "module" : kind === "style" ? "style" : kind === "script" ? "script" : "asset";
		return k + ":" + real;
	}

	/** Borrow a finished entry (and whatever it points at) from the previous generation. */
	private inherit(key: string): Entry | undefined {
		const from = this.prev?.cache.get(key);
		// modules are left alone: their import-map cycle entries belong to the old document
		if (!from || !from.settled || !from.value || from.kind === "module") return undefined;
		const e: Entry = { ...from, used: performance.now() };
		this.cache.set(key, e);
		this.hold(from.value);
		if (e.kind === "image" && !e.pinned) this.imageBytes += e.bytes;
		for (const d of e.deps ?? []) if (!this.cache.has(d)) this.inherit(d);
		return e;
	}

	private lookup(key: string): Entry | undefined {
		const e = this.cache.get(key) ?? this.inherit(key);
		if (e) {
			e.used = performance.now();
			if (e.kind === "image" && !e.pinned) {
				// keep the map in least-recently-used order for eviction
				this.cache.delete(key);
				this.cache.set(key, e);
			}
		}
		return e;
	}

	peek(virtual: string, kind: ResourceKind = "image"): string | null | undefined {
		const e = this.lookup(this.key(kind, virtual));
		return e?.settled ? e.value : undefined;
	}

	resolve(virtual: string, kind: ResourceKind, rc: ResolveContext = {}): Promise<string | null> {
		const hashIdx = virtual.indexOf("#");
		const hash = hashIdx === -1 ? "" : virtual.slice(hashIdx);
		const bare = hashIdx === -1 ? virtual : virtual.slice(0, hashIdx);
		if (kind === "module") return this.resolveModule(bare, [], rc);

		const key = this.key(kind, bare);
		let e = this.lookup(key);
		if (!e) {
			e = this.track(
				key,
				kind,
				// a page that's gone doesn't need what it queued; don't spend wisp streams on it
				this.sem.run(() => (this.closed ? Promise.resolve(null) : this.fetchAsset(bare, kind, rc)))
			);
		}
		const p = e.p;
		if (!hash) return p;
		// fragments matter for svg <use href="sprite.svg#icon">; the codec encoded it
		return p.then((u) => (u ? u + "#" + this.ctrl.codecDecode(hash.slice(1)) : u));
	}

	private track(key: string, kind: ResourceKind, made: Promise<Made | null>): Entry {
		const e: Entry = {
			p: null!,
			settled: false,
			value: null,
			kind: kind === "font" || kind === "image" || kind === "style" || kind === "script" ? kind : kind === "module" ? "module" : "media",
			bytes: 0,
			pinned: false,
			used: performance.now(),
		};
		e.p = made.then(
			(m) => {
				e.settled = true;
				if (!m) return null;
				e.value = m.url;
				e.bytes = m.bytes;
				e.deps = m.deps;
				if (this.cache.get(key) === e && e.kind === "image" && !e.pinned) {
					this.imageBytes += m.bytes;
					if (this.imageBytes > IMAGE_BUDGET) this.evictImages();
				}
				return m.url;
			},
			() => {
				e.settled = true;
				if (this.cache.get(key) === e) this.cache.delete(key);
				return null;
			}
		);
		this.cache.set(key, e);
		return e;
	}

	private evictImages() {
		const cutoff = performance.now() - IMAGE_IDLE_MS;
		for (const [key, e] of this.cache) {
			if (this.imageBytes <= IMAGE_BUDGET * 0.75) break;
			if (e.kind !== "image" || e.pinned || !e.settled || !e.value) continue;
			// the map is in lru order for images, so the rest are newer still
			if (e.used > cutoff) break;
			this.cache.delete(key);
			this.imageBytes -= e.bytes;
			this.drop(e.value);
		}
	}

	private pin(key: string) {
		const e = this.cache.get(key);
		if (!e || e.pinned) return;
		e.pinned = true;
		if (e.kind === "image" && e.settled && e.value) this.imageBytes -= e.bytes;
	}

	private async fetchAsset(virtual: string, kind: ResourceKind, rc: ResolveContext): Promise<Made | null> {
		const res = await this.ctrl.serve({
			url: virtual,
			destination: DESTINATIONS[kind],
			mode: "no-cors",
			clientUrl: rc.clientUrl,
			clientId: rc.clientId,
			referrer: rc.clientUrl,
		});
		if (this.closed || (res.status >= 400 && kind !== "script" && kind !== "style")) {
			// images etc: an unusable url makes the element fire "error" like a 404 would
			discardBody(res.body);
			return null;
		}
		if (res.status >= 400) {
			console.warn(`[sjl] ${res.status} for ${this.ctrl.unrewrite(virtual)}`);
			discardBody(res.body);
			return null;
		}
		const ct = header(res, "content-type") || "";
		if (kind === "script") {
			return this.makeBlob(await bodyToBlob(res.body, "text/javascript"));
		}
		if (kind === "style") {
			const deps: string[] = [];
			const css = await this.resolveCss(await bodyToText(res.body), rc, deps);
			const m = await this.makeBlob(new Blob([css], { type: "text/css" }));
			if (m) m.deps = deps;
			return m;
		}
		const type = ct.split(";")[0].trim() || (kind === "font" ? "font/woff2" : "");
		return this.makeBlob(await bodyToBlob(res.body, type));
	}

	/**
	 * Replace every virtual url inside css text with a blob url. @import targets are
	 * resolved as stylesheets (recursively), everything else as images/fonts.
	 */
	/** data:/blob: urls get "rewritten" into the virtual space too; they need no fetch */
	private directCss(css: string) {
		const p = this.ctrl.prefix.href;
		if (!css.includes(p + "data:") && !css.includes(p + "blob:")) return css;
		css = css.split(p + "data:").join("data:");
		return css.replace(new RegExp(escapeRegExp(p) + "blob:[^/]+//[^/]+/", "g"), "blob:" + BLOB_ORIGIN + "/");
	}

	private cssKind(css: string, url: string, index: number): ResourceKind {
		const before = css.slice(Math.max(0, index - 24), index);
		if (/@import\s*(url\(\s*)?["']?$/i.test(before)) return "style";
		return FONT_EXT.test(this.ctrl.unrewrite(url)) ? "font" : "image";
	}

	async resolveCss(css: string, rc: ResolveContext = {}, deps?: string[]): Promise<string> {
		if (!css.includes(this.ctrl.prefix.href)) return css;
		css = this.directCss(css);
		const found = new Map<string, ResourceKind>();
		for (const m of css.matchAll(this.cssUrlRe)) {
			if (!found.has(m[0])) found.set(m[0], this.cssKind(css, m[0], m.index!));
		}
		const resolved = new Map<string, string>();
		await Promise.all(
			[...found].map(async ([url, kind]) => {
				const blob = await this.resolve(url, kind, rc).catch(() => null);
				const key = this.key(kind, url);
				this.pin(key);
				deps?.push(key);
				resolved.set(url, blob ?? "about:invalid");
			})
		);
		return css.replace(this.cssUrlRe, (u) => resolved.get(u) ?? u);
	}

	/** Synchronous best effort: swap in blobs we already have, blank out the rest. */
	cachedCss(css: string): string {
		if (!css.includes(this.ctrl.prefix.href)) return css;
		css = this.directCss(css);
		return css.replace(this.cssUrlRe, (u) => {
			const real = this.ctrl.unrewrite(u);
			const kind: ResourceKind = FONT_EXT.test(real) ? "font" : "image";
			const hit = this.peek(u, kind);
			if (hit) this.pin(this.key(kind, u));
			return hit ?? this.peek(u, "style") ?? "about:invalid";
		});
	}

	hasModuleLiterals(js: string) {
		this.moduleLitRe.lastIndex = 0;
		if (this.moduleLitRe.test(js)) return true;
		return !!this.imports && /\b(from|import)\s*["'][^"'./]/.test(js);
	}

	// the document's import map, with real (unrewritten) absolute urls. bare specifiers
	// are left alone by the js rewriter, and prefix mappings ("lib/": "./lib/") can't
	// point at blob urls, so we resolve them while linking instead
	private imports: Record<string, string> | null = null;
	setImportMap(imports: Record<string, string>) {
		this.imports = { ...(this.imports ?? {}), ...imports };
	}

	/** bare specifier → virtual url, per the import map */
	resolveBare(spec: string): string | null {
		const map = this.imports;
		if (!map) return null;
		let real: string | null = null;
		if (map[spec]) real = map[spec];
		else {
			let best = "";
			for (const k in map) if (k.endsWith("/") && spec.startsWith(k) && k.length > best.length) best = k;
			if (best) real = map[best] + spec.slice(best.length);
		}
		if (!real) return null;
		try {
			const u = new URL(this.ctrl.virtualFor(real));
			u.searchParams.set("$module", "module");
			return u.href;
		} catch {
			return null;
		}
	}

	// module keys currently being fetched/linked, and which dependencies each is waiting on.
	// used to spot cycles even when the two halves were reached through different branches
	private moduleWaits = new Map<string, Set<string>>();
	private cycleEntries = new Map<string, Promise<string | null>>();

	private reaches(from: string, to: string, seen = new Set<string>()): boolean {
		if (from === to) return true;
		if (seen.has(from)) return false;
		seen.add(from);
		for (const next of this.moduleWaits.get(from) ?? [])
			if (this.reaches(next, to, seen)) return true;
		return false;
	}

	/**
	 * Static imports can't be intercepted without a service worker, so resolve the whole
	 * graph up front: fetch each dependency, link its own imports, and rewrite the
	 * specifier to the dependency's blob url. Import cycles can't be expressed with
	 * content-addressed blob urls; those back-edges keep an absolute url and get an
	 * import map entry instead (dynamic import maps, Chromium 133+).
	 */
	async linkModule(js: string, selfKey: string | null, rc: ResolveContext): Promise<string> {
		if (this.imports) js = await this.linkBare(js, selfKey, rc);
		this.moduleLitRe.lastIndex = 0;
		const literals = new Set<string>();
		for (const m of js.matchAll(this.moduleLitRe)) literals.add(m[2]);
		if (!literals.size) return js;

		const replacements = new Map<string, string>();
		const origin = this.ctrl.prefix.origin;
		await Promise.all(
			[...literals].map(async (lit) => {
				const abs = origin + lit;
				const key = this.key("module", abs);
				if (selfKey && this.moduleWaits.has(key) && this.reaches(key, selfKey)) {
					if (!this.cycleEntries.has(abs)) this.cycleEntries.set(abs, this.cache.get(key)!.p);
					replacements.set(lit, abs);
					return;
				}
				if (selfKey) this.moduleWaits.get(selfKey)?.add(key);
				const blob = await this.resolveModuleInner(abs, rc);
				replacements.set(lit, blob ?? "about:invalid");
			})
		);
		return js.replace(this.moduleLitRe, (whole, q, lit) => {
			const r = replacements.get(lit);
			return r ? q + r + q : whole;
		});
	}

	private bareRe = /(\bfrom\s*|\bimport\s*)(["'])([^"'.\/\s][^"'\s]*)\2/g;
	private async linkBare(js: string, selfKey: string | null, rc: ResolveContext) {
		const specs = new Set<string>();
		for (const m of js.matchAll(this.bareRe)) if (!m[3].includes(":")) specs.add(m[3]);
		if (!specs.size) return js;
		const out = new Map<string, string>();
		await Promise.all(
			[...specs].map(async (spec) => {
				const v = this.resolveBare(spec);
				if (!v) return;
				// same cycle handling as relative imports, via a root-relative literal
				const lit = v.slice(this.ctrl.prefix.origin.length);
				out.set(spec, lit);
			})
		);
		return js.replace(this.bareRe, (whole, kw, q, spec) => (out.has(spec) ? kw + q + out.get(spec) + q : whole));
	}

	async resolveModule(virtual: string, _stack: string[], rc: ResolveContext): Promise<string | null> {
		const blob = await this.resolveModuleInner(virtual, rc);
		if (this.cycleEntries.size && rc.importMap) {
			const entries: Record<string, string> = {};
			for (const [abs, p] of this.cycleEntries) {
				const b = await p;
				if (b) entries[abs] = b;
			}
			rc.importMap(entries);
		}
		return blob;
	}

	private resolveModuleInner(virtual: string, rc: ResolveContext): Promise<string | null> {
		const url = new URL(virtual);
		// without $module the rewriter would parse it as a classic script
		if (!url.searchParams.has("$module")) url.searchParams.set("$module", "module");
		const key = this.key("module", virtual);
		const existing = this.cache.get(key);
		if (existing) return existing.p;

		this.moduleWaits.set(key, new Set());
		return this.track(
			key,
			"module",
			(async (): Promise<Made | null> => {
				try {
					const res = await this.sem.run(async () =>
						this.closed
							? null
							: this.ctrl.serve({
									url: url.href,
									destination: "script",
									mode: "cors",
									clientUrl: rc.clientUrl,
									clientId: rc.clientId,
									referrer: rc.clientUrl,
								})
					);
					if (!res) return null;
					if (res.status >= 400) {
						console.warn(`[sjl] ${res.status} for module ${this.ctrl.unrewrite(virtual)}`);
						discardBody(res.body);
						return null;
					}
					const ct = header(res, "content-type");
					if (!isJsType(ct)) {
						// json / css module scripts keep their own type
						return this.makeBlob(await bodyToBlob(res.body, ct!.split(";")[0]));
					}
					const js = await this.linkModule(await bodyToText(res.body), key, rc);
					return this.makeBlob(new Blob([js], { type: "text/javascript" }));
				} finally {
					this.moduleWaits.delete(key);
				}
			})()
		).p;
	}

	/**
	 * Worker entry scripts: rewritten with the worker rewriter, graph-linked if module.
	 * importScripts() is synchronous, so literal importScripts("...") targets are fetched
	 * now and handed to the worker as a url → blob map.
	 */
	async resolveWorker(virtual: string, isModule: boolean, rc: ResolveContext) {
		const url = new URL(virtual);
		if (isModule) url.searchParams.set("$module", "module");
		const res = await this.ctrl.serve({
			url: url.href,
			destination: "worker",
			mode: "same-origin",
			clientUrl: rc.clientUrl,
			clientId: rc.clientId,
			referrer: rc.clientUrl,
		});
		if (res.status >= 400) {
			discardBody(res.body);
			return null;
		}
		let js = await bodyToText(res.body);
		if (isModule) js = await this.linkModule(js, null, rc);

		const scripts: Record<string, string> = {};
		if (!isModule) {
			const real = this.ctrl.unrewrite(res.url);
			const targets = new Set<string>();
			for (const call of js.matchAll(/importScripts\s*\(([^)]*)\)/g)) {
				for (const lit of call[1].matchAll(/(["'`])((?:(?!\1)[^\\\n])+)\1/g)) {
					try {
						const abs = new URL(lit[2], real);
						if (abs.protocol === "http:" || abs.protocol === "https:") targets.add(abs.href);
					} catch {}
				}
			}
			await Promise.all(
				[...targets].map(async (t) => {
					const blob = await this.resolve(this.ctrl.virtualFor(t), "script", rc).catch(() => null);
					if (blob) scripts[t] = blob;
				})
			);
		}
		const code = await this.makeBlob(new Blob([js], { type: "text/javascript" }));
		return code ? { code: code.url, scripts, text: isModule ? undefined : js } : null;
	}
}
