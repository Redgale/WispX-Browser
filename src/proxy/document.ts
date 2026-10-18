// Loading documents without a service worker.
//
// A navigation is: fetch the page through scramjet's handler (which rewrites the HTML),
// pre-resolve everything the HTML parser would otherwise fetch synchronously from the
// virtual /~/sj/ space (scripts, stylesheets, module graphs, import maps), mark the lazy
// stuff (images, media, iframes) for the realm's sink layer to fill in, then write the
// result into a fresh same-origin frame (a blob: document of ours, or a srcdoc one at an
// opaque origin) whose URL we've set to the virtual url with history.replaceState where the
// browser allows it. Scramjet derives the page's location from that URL, or from the url the
// controller tracks when the frame's url can't be changed.

import type { Controller, NavInit, TabHost } from "./controller";
import { REALM } from "./controller";
import { SRCDOC_FRAMES, useSrcdocFrames } from "./env";
import { bodyToText, discardBody, type ResolveContext, type Resources } from "./resources";

const JS_TYPES = new Set([
	"",
	"text/javascript",
	"application/javascript",
	"text/ecmascript",
	"application/ecmascript",
	"application/x-javascript",
	"application/x-ecmascript",
	"text/x-javascript",
	"text/x-ecmascript",
	"text/jscript",
	"text/livescript",
	"text/javascript1.0",
	"text/javascript1.1",
	"text/javascript1.2",
	"text/javascript1.3",
	"text/javascript1.4",
	"text/javascript1.5",
]);

// elements whose resources can load after the document is written. the sink layer in
// the realm picks these markers up (scramjet hides scramjet-attr-* from the page)
const LAZY_ATTRS: Array<[string, string]> = [
	["img", "src"],
	["img", "srcset"],
	["source", "src"],
	["source", "srcset"],
	["video", "src"],
	["video", "poster"],
	["audio", "src"],
	["track", "src"],
	["input", "src"],
	["embed", "src"],
	["object", "data"],
	["iframe", "src"],
	["frame", "src"],
	["link", "imagesrcset"],
];
const SVG_LAZY = ["image", "use", "feImage"];
export const PENDING = "scramjet-attr-sjlp-";
// virtual url of an attribute we already swapped for a blob, so script.src etc. report
// the right url (loaders often derive their base path from their own <script src>)
export const ORIGINAL = "scramjet-attr-sjlv-";

function header(headers: [string, string][], name: string) {
	name = name.toLowerCase();
	for (const [k, v] of headers) if (k.toLowerCase() === name) return v;
	return null;
}

function isHtmlType(ct: string | null) {
	if (!ct) return false;
	const t = ct.split(";")[0].trim().toLowerCase();
	return t === "text/html" || t === "application/xhtml+xml";
}

function scriptKind(el: Element): "classic" | "module" | null {
	if (el.hasAttribute("nomodule")) return null;
	const hasType = el.hasAttribute("type");
	let type = (el.getAttribute("type") ?? "").trim().toLowerCase();
	if (!hasType) {
		const lang = el.getAttribute("language");
		if (lang) type = "text/" + lang.trim().toLowerCase();
	}
	if (type === "module") return "module";
	return JS_TYPES.has(type) ? "classic" : null;
}

function doctypeString(doc: Document) {
	const dt = doc.doctype;
	if (!dt) return "";
	let s = "<!DOCTYPE " + dt.name;
	if (dt.publicId) s += ` PUBLIC "${dt.publicId}"`;
	if (dt.systemId) s += (dt.publicId ? "" : " SYSTEM") + ` "${dt.systemId}"`;
	return s + ">";
}

/**
 * Take rewritten HTML and make it loadable from a blob-only world. Everything the parser
 * would block on is resolved before we return; everything else is deferred to the realm.
 */
export async function prepareHtml(
	ctrl: Controller,
	res: Resources,
	html: string,
	rc: ResolveContext
): Promise<string> {
	const doc = new DOMParser().parseFromString(html, "text/html");
	const jobs: Promise<unknown>[] = [];
	const cycleMap: Record<string, string> = {};
	const rcDoc: ResolveContext = {
		...rc,
		importMap: (entries) => Object.assign(cycleMap, entries),
	};
	const virtual = (v: string | null) => !!v && ctrl.isVirtual(v);
	const inNoscript = (el: Element) => !!el.closest("noscript");

	for (const el of doc.querySelectorAll("script")) {
		if (inNoscript(el)) continue;
		const type = (el.getAttribute("type") ?? "").trim().toLowerCase();
		if (type === "importmap") {
			jobs.push(
				(async () => {
					try {
						const map = JSON.parse(el.textContent || "{}");
						const imports = map.imports ?? {};
						// remember the real targets; the linker resolves bare specifiers itself
						const real: Record<string, string> = {};
						for (const k of Object.keys(imports)) {
							const v = imports[k];
							if (typeof v !== "string") continue;
							let r = virtual(v) ? ctrl.unrewrite(v) : v;
							if (k.endsWith("/") && !r.endsWith("/")) r = r.replace(/[?#].*$/, "");
							if (k.endsWith("/") && !r.endsWith("/")) r += "/";
							real[k] = r;
						}
						res.setImportMap(real);
						await Promise.all(
							Object.keys(imports).map(async (k) => {
								const v = imports[k];
								if (typeof v !== "string" || !virtual(v)) return;
								// prefix mappings can't point at blobs; drop them (handled by the linker)
								if (k.endsWith("/")) delete imports[k];
								else imports[k] = (await res.resolve(v, "module", rcDoc)) ?? v;
							})
						);
						el.textContent = JSON.stringify(map);
					} catch {
						/* leave it */
					}
				})()
			);
			continue;
		}
		const kind = scriptKind(el);
		if (!kind) continue;
		const src = el.getAttribute("src");
		if (src !== null) {
			if (!virtual(src)) continue;
			jobs.push(
				res
					.resolve(src, kind === "module" ? "module" : "script", rcDoc)
					.catch(() => null)
					.then((blob) => {
						el.setAttribute(ORIGINAL + "src", src);
						el.setAttribute("src", blob ?? "about:invalid");
					})
			);
		} else if (kind === "module" && res.hasModuleLiterals(el.textContent || "")) {
			jobs.push(
				res.linkModule(el.textContent || "", null, rcDoc).then((js) => {
					el.textContent = js;
				})
			);
		}
	}

	for (const el of doc.querySelectorAll("link[href]")) {
		if (inNoscript(el)) continue;
		const href = el.getAttribute("href")!;
		if (!virtual(href)) continue;
		const rel = (el.getAttribute("rel") || "").toLowerCase().split(/\s+/);
		const as = (el.getAttribute("as") || "").toLowerCase();
		if (rel.includes("stylesheet")) {
			jobs.push(
				res
					.resolve(href, "style", rcDoc)
					.catch(() => null)
					.then((blob) => {
						el.setAttribute(ORIGINAL + "href", href);
						el.setAttribute("href", blob ?? "about:invalid");
					})
			);
		} else if (rel.includes("icon") || rel.includes("apple-touch-icon")) {
			el.removeAttribute("href");
			el.setAttribute(PENDING + "href", href);
		} else if (rel.includes("modulepreload")) {
			// warm the module cache; the real <script type=module> will get the same blob
			res.resolve(href, "module", rcDoc).catch(() => {});
			el.remove();
		} else if (rel.includes("preload") || rel.includes("prefetch")) {
			const kind = as === "style" ? "style" : as === "script" ? "script" : as === "font" ? "font" : as === "image" ? "image" : null;
			if (kind) res.resolve(href, kind, rcDoc).catch(() => {});
			// preloaded styles get promoted with onload="this.rel='stylesheet'"; keep that
			// working by letting the sink layer swap in a blob and fire load
			el.removeAttribute("href");
			el.setAttribute(PENDING + "href", href);
		} else if (rel.includes("manifest") || rel.includes("dns-prefetch") || rel.includes("preconnect")) {
			el.remove();
		}
	}

	// the browser would navigate the frame by itself, which can't be caught where the
	// Navigation API has no events; the realm's sink layer schedules it instead
	for (const el of doc.querySelectorAll("meta[http-equiv]")) {
		if (el.getAttribute("http-equiv")!.trim().toLowerCase() === "refresh" && !inNoscript(el))
			el.setAttribute("http-equiv", "x-sjl-refresh");
	}

	for (const el of doc.querySelectorAll("style")) {
		const css = el.textContent || "";
		if (css.includes(ctrl.prefix.href))
			jobs.push(res.resolveCss(css, rcDoc).then((c) => (el.textContent = c)));
	}
	for (const el of doc.querySelectorAll("[style]")) {
		const css = el.getAttribute("style")!;
		if (css.includes(ctrl.prefix.href))
			jobs.push(res.resolveCss(css, rcDoc).then((c) => el.setAttribute("style", c)));
	}

	for (const [tag, attr] of LAZY_ATTRS) {
		for (const el of doc.querySelectorAll(`${tag}[${attr}]`)) {
			const v = el.getAttribute(attr)!;
			if (!v.includes(ctrl.prefix.href)) continue;
			el.removeAttribute(attr);
			el.setAttribute(PENDING + attr, v);
		}
	}
	for (const el of doc.querySelectorAll(SVG_LAZY.join(","))) {
		for (const attr of ["href", "xlink:href"]) {
			const v = el.getAttribute(attr);
			if (!v || !virtual(v)) continue;
			el.removeAttribute(attr);
			el.setAttribute(PENDING + attr, v);
		}
	}

	await Promise.all(jobs);

	if (Object.keys(cycleMap).length) {
		// module cycles: must be mapped before the first module script runs
		const existing = doc.querySelector('script[type="importmap"]');
		if (existing) {
			const map = JSON.parse(existing.textContent || "{}");
			map.imports = { ...cycleMap, ...(map.imports ?? {}) };
			existing.textContent = JSON.stringify(map);
		} else {
			const s = doc.createElement("script");
			s.type = "importmap";
			s.textContent = JSON.stringify({ imports: cycleMap });
			doc.head.prepend(s);
		}
	}

	return doctypeString(doc) + doc.documentElement.outerHTML;
}

// read through the parent realm so a hooked child realm can't interfere
const nativeContentWindow = Object.getOwnPropertyDescriptor(
	HTMLIFrameElement.prototype,
	"contentWindow"
)!.get!;
const nativeSetAttribute = Element.prototype.setAttribute;
const nativeOpen = Document.prototype.open;
const nativeWrite = Document.prototype.write;
const nativeClose = Document.prototype.close;
const nativeReplaceState = History.prototype.replaceState;

function realmState(win: any) {
	try {
		return Object.prototype.hasOwnProperty.call(win, REALM) ? win[REALM] : undefined;
	} catch {
		return undefined;
	}
}

/** Write a prepared document into a same-origin window and adopt it. */
export function writeDocument(
	ctrl: Controller,
	tab: TabHost,
	win: any,
	virtualUrl: string,
	html: string,
	init: {
		initHeaders?: [string, string][];
		history?: any[];
		isTabTop?: boolean;
		clientId?: string;
		/** runs once the realm exists, before the page's first script (devtools' console buffer) */
		beforeWrite?: (win: any) => void;
	}
) {
	const doc = win.document;
	nativeOpen.call(doc);
	// document.open() gave the frame our url; give it the virtual one where the browser
	// allows it. When this app runs from a blob: url it doesn't (a blob: document can't
	// take an http(s) url); the controller then tracks the url itself.
	try {
		nativeReplaceState.call(win.history, null, "", virtualUrl);
	} catch {}
	const { beforeWrite, ...adoptInit } = init;
	ctrl.adopt(win, tab, { ...adoptInit, virtualUrl });
	realmState(win).written = true;
	try {
		beforeWrite?.(win);
	} catch {}
	nativeWrite.call(doc, html);
	nativeClose.call(doc);
}

function watchFrameLoads(ctrl: Controller, tab: TabHost, iframe: HTMLIFrameElement) {
	if ((iframe as any).__sjlWatched) return;
	Object.defineProperty(iframe, "__sjlWatched", { value: true });
	// safety net: if a navigation escaped interception, the frame lands on a real
	// /~/sj/ url on our host (a 404). catch that and load it properly
	iframe.addEventListener("load", () => {
		const win: any = nativeContentWindow.call(iframe);
		if (!win || realmState(win)?.written) return;
		let href = "";
		try {
			href = win.location.href;
		} catch {
			return;
		}
		if (ctrl.isVirtual(href)) loadIntoFrame(ctrl, tab, iframe, href, {});
	});
}

const frameGen = new WeakMap<HTMLIFrameElement, number>();

// Chrome disables Navigation API events for about:blank documents (initial or not), even
// after document.open(), and we need those events to catch navigations. A document loaded
// from a blob: url we created is same-origin, gets them, and loads without a round trip.
// At an opaque origin a blob: document gets an origin of its own, but a srcdoc document
// inherits ours (and gets the events too, except where the origin is truly opaque).
//
// Each load gets a blob url of its own. When documents keep the blob's url (the virtual one
// can't be set, i.e. this app runs from a blob: url), replace()ing a frame's document with
// one at its own url, after a history.back() inside it, freezes Chrome's renderer.
const primeUrls = new Set<string>();
function newPrimeUrl() {
	const url = URL.createObjectURL(new Blob(["<!doctype html>"], { type: "text/html" }));
	primeUrls.add(url);
	return url;
}
export const isPrimeUrl = (href: string) => (SRCDOC_FRAMES ? href === "about:srcdoc" : primeUrls.has(href));

let primeCount = 0;

/** Give the frame a brand new (blank, same-origin) document and window. */
export async function primeFrame(iframe: HTMLIFrameElement): Promise<any> {
	await new Promise<void>((resolve) => {
		iframe.addEventListener("load", () => resolve(), { once: true });
		if (SRCDOC_FRAMES) {
			// a new value each time, so it always loads. about:srcdoc to about:srcdoc replaces
			// the history entry, like location.replace() below
			nativeSetAttribute.call(iframe, "srcdoc", "<!doctype html><!--" + ++primeCount + "-->");
			return;
		}
		const url = newPrimeUrl();
		const win: any = nativeContentWindow.call(iframe);
		try {
			// replace(): no extra session history entry per navigation
			win.location.replace(url);
		} catch {
			nativeSetAttribute.call(iframe, "src", url);
		}
	});
	const win: any = nativeContentWindow.call(iframe);
	if (!SRCDOC_FRAMES) {
		try {
			void win.document.documentElement;
		} catch {
			// detectFrameMode() can't catch every case; don't fail the page over it
			useSrcdocFrames();
			return primeFrame(iframe);
		}
	}
	return win;
}

export type FetchedDocument =
	| { kind: "html"; url: string; html: string; headers: [string, string][]; status: number }
	| { kind: "other"; url: string; blobUrl: string; type: string; status: number }
	| { kind: "download"; url: string };

/** Fetch a navigation target through the handler and make it writable. */
export async function fetchDocument(
	ctrl: Controller,
	tab: TabHost,
	url: string,
	init: NavInit & { iframe?: boolean; clientId?: string }
): Promise<FetchedDocument> {
	const res = await ctrl.serve({
		url,
		method: init.method,
		body: init.body,
		headers: init.headers,
		destination: init.iframe ? "iframe" : "document",
		mode: "navigate",
		credentials: "include",
		referrer: init.referrer,
		clientUrl: init.referrer,
		clientId: init.clientId ?? tab.clientId,
	});
	if (res.status === 204 || res.status === 205) {
		// "no content": a browser stays on the current page
		discardBody(res.body);
		return { kind: "download", url: res.url };
	}
	const ct = header(res.headers, "content-type");
	const disposition = header(res.headers, "content-disposition");
	if (disposition && /^\s*attachment/i.test(disposition)) {
		await saveBody(res.body, ct, filenameFrom(disposition, ctrl.unrewrite(res.url)));
		return { kind: "download", url: res.url };
	}
	if (isHtmlType(ct)) {
		return { kind: "html", url: res.url, html: await bodyToText(res.body), headers: res.headers, status: res.status };
	}
	if (!ct && res.status < 400) {
		// no content-type: sniff for html the way a browser would, and rewrite it ourselves
		const text = await bodyToText(res.body);
		if (/^\s*(<!doctype html|<html|<head|<body|<script|<!--)/i.test(text)) {
			const real = new URL(ctrl.unrewrite(res.url));
			const html = $scramjet.rewriteHtml(text, ctrl.handler.context, { origin: real, base: real } as any, {
				loadScripts: true,
				inline: false,
				source: real.href,
				headers: res.headers,
				history: ctrl.handler.trackedClients.get(init.clientId ?? tab.clientId)?.history ?? [],
			});
			return { kind: "html", url: res.url, html, headers: res.headers, status: res.status };
		}
		const blob = new Blob([text], { type: "text/plain" });
		return { kind: "other", url: res.url, blobUrl: URL.createObjectURL(blob), type: "text/plain", status: res.status };
	}
	const type = (ct || "application/octet-stream").split(";")[0].trim();
	if (!/^(image|video|audio|text)\/|^application\/(pdf|json|xml)|\+xml$|\+json$/i.test(type)) {
		await saveBody(res.body, ct, filenameFrom(null, ctrl.unrewrite(res.url)));
		return { kind: "download", url: res.url };
	}
	// images, video, pdf, plain text, json: let the browser's own viewer show a blob
	const blob = new Blob([await new Response(res.body).arrayBuffer()], {
		type: /^text\/|json|xml/.test(type) ? type + ";charset=utf-8" : type,
	});
	return { kind: "other", url: res.url, blobUrl: URL.createObjectURL(blob), type, status: res.status };
}

/** Navigate an iframe inside a proxied page. */
export async function loadIntoFrame(
	ctrl: Controller,
	tab: TabHost,
	iframe: HTMLIFrameElement,
	url: string,
	init: NavInit
) {
	const gen = (frameGen.get(iframe) ?? 0) + 1;
	frameGen.set(iframe, gen);
	watchFrameLoads(ctrl, tab, iframe);
	const clientId = "f" + Math.random().toString(36).slice(2, 10);
	try {
		const fetched = await fetchDocument(ctrl, tab, url, { ...init, iframe: true, clientId });
		if (fetched.kind === "other") tab.resources.own(fetched.blobUrl);
		if (frameGen.get(iframe) !== gen || fetched.kind === "download") return;
		if (fetched.kind === "other") {
			try {
				(nativeContentWindow.call(iframe) as any).location.replace(fetched.blobUrl);
			} catch {
				nativeSetAttribute.call(iframe, "src", fetched.blobUrl);
			}
			return;
		}
		const html = await prepareHtml(ctrl, tab.resources, fetched.html, { clientUrl: fetched.url, clientId });
		if (frameGen.get(iframe) !== gen || !iframe.isConnected) return;
		ctrl.release(nativeContentWindow.call(iframe));
		const win = await primeFrame(iframe);
		if (!win || frameGen.get(iframe) !== gen) return;
		writeDocument(ctrl, tab, win, fetched.url, html, {
			initHeaders: fetched.headers,
			history: ctrl.handler.trackedClients.get(clientId)?.history ?? [],
			clientId,
		});
	} catch (e) {
		console.warn("[sjl] frame load failed", ctrl.unrewrite(url), e);
	}
}

function filenameFrom(disposition: string | null, url: string) {
	if (disposition) {
		const star = /filename\*\s*=\s*(?:UTF-8'')?([^;]+)/i.exec(disposition);
		if (star) {
			try {
				return decodeURIComponent(star[1].trim().replace(/^"|"$/g, ""));
			} catch {}
		}
		const plain = /filename\s*=\s*("?)([^";]+)\1/i.exec(disposition);
		if (plain) return plain[2].trim();
	}
	try {
		const name = new URL(url).pathname.split("/").filter(Boolean).pop();
		return name ? decodeURIComponent(name) : "download";
	} catch {
		return "download";
	}
}

async function saveBody(body: any, ct: string | null, filename: string) {
	const blob = new Blob([await new Response(body).arrayBuffer()], {
		type: ct || "application/octet-stream",
	});
	const a = document.createElement("a");
	a.href = URL.createObjectURL(blob);
	a.download = filename;
	document.body.append(a);
	a.click();
	a.remove();
	setTimeout(() => URL.revokeObjectURL(a.href), 60_000);
}

/** <a download> and friends inside a proxied page. */
export async function downloadResource(ctrl: Controller, tab: TabHost, url: string, filename?: string) {
	try {
		const res = await ctrl.serve({ url, destination: "", mode: "navigate", clientId: tab.clientId });
		const ct = header(res.headers, "content-type");
		await saveBody(
			res.body,
			ct,
			filename || filenameFrom(header(res.headers, "content-disposition"), ctrl.unrewrite(res.url))
		);
	} catch (e) {
		console.warn("[sjl] download failed", e);
	}
}
