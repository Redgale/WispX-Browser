// The service-worker-less controller.
//
// In stock Scramjet 2 the page-side Controller (from @mercuryworkshop/scramjet-controller)
// already runs the ScramjetFetchHandler, and the service worker only forwards requests
// to it over a MessagePort. Here that middleman is gone:
//   * `serve()` is what the SW's fetch route used to call: it runs the handler directly.
//   * every proxied window is a same-origin about:blank iframe that we `adopt()`: load
//     scramjet into it, install the sink layer (src/realm/sink.js) under scramjet's hooks,
//     then hook it. The sink layer is what answers requests for virtual /~/sj/ urls that
//     the browser would otherwise send to the (nonexistent) service worker.

import SINK_SOURCE from "../realm/sink.js?raw";
import WORKER_BOOT_SOURCE from "../realm/worker.js?raw";
import { SCRAMJET_SOURCE, SwitchableTransport, WASM_BYTES, loadScramjet } from "./runtime";
import { BLOB_ORIGIN, PREFIX } from "./env";
import { Resources, discardBody, liveBlobCount, type ResourceKind } from "./resources";
import { loadIntoFrame, prepareHtml, downloadResource } from "./document";
import { RealmNet, realmSocketCount } from "./realm-net";

export type ServeRequest = {
	url: string;
	method?: string;
	headers?: [string, string][];
	body?: any;
	destination?: RequestDestination;
	mode?: RequestMode;
	credentials?: RequestCredentials;
	redirect?: RequestRedirect;
	referrer?: string;
	clientUrl?: string;
	clientId?: string;
};

export type ServeResponse = {
	status: number;
	statusText: string;
	headers: [string, string][];
	body: any;
	/** final virtual url after redirects */
	url: string;
	redirected: boolean;
	/** raw headers from the origin for the document (initHeaders for the client) */
	rawHeaders?: [string, string][];
};

export type NavInit = {
	method?: string;
	body?: any;
	headers?: [string, string][];
	referrer?: string;
	replace?: boolean;
	reload?: boolean;
};

/** What the browser UI implements for each tab. */
export interface TabHost {
	id: string;
	clientId: string;
	frameName: string;
	resources: Resources;
	/** navigation requested from inside the page (link click, location = ..., form) */
	navigate(url: string, init?: NavInit): void;
	/** the window of the tab's frame (the page's `top`) */
	topWindow(): Window | null;
	open(url: string | null, opts?: { background?: boolean; opener?: Window; name?: string }): Window | null;
	urlChanged(realUrl: string): void;
	/** the page did history.pushState (so Back can stay inside the document) */
	historyPushed(): void;
	/** the top document fired its load event */
	loaded(): void;
	titleChanged(title: string): void;
	iconChanged(url: string | null): void;
	shortcut(e: { key: string; ctrl: boolean; alt: boolean; shift: boolean; meta: boolean; repeat?: boolean }): boolean;
}

export type RealmState = {
	tab: TabHost;
	client: any;
	sink: any;
	/** sockets, streams and worker ports this realm has open; closed when it unloads */
	net: RealmNet;
	clientId: string;
	written: boolean;
	isTabTop: boolean;
	/**
	 * The page's virtual url. Normally the frame's real url is set to it with
	 * replaceState, but when this app itself runs from a blob: url, documents it writes get
	 * blob: urls that can't be rewritten to http(s). So we track it here and hand it to
	 * scramjet ourselves, and only use the real url when it agrees.
	 */
	virtualUrl: string;
};

export const REALM = Symbol.for("sjl realm");

const REDIRECTS = [301, 302, 303, 307, 308];
const ACCEPT: Partial<Record<RequestDestination, string>> = {
	document:
		"text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8",
	iframe:
		"text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8",
	image: "image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8",
	style: "text/css,*/*;q=0.1",
};

let acceptLanguageValue: string | null = null;
addEventListener("languagechange", () => (acceptLanguageValue = null));
function acceptLanguage() {
	if (acceptLanguageValue) return acceptLanguageValue;
	const langs = navigator.languages?.length ? navigator.languages : [navigator.language || "en-US"];
	return (acceptLanguageValue = langs
		.slice(0, 6)
		.map((l, i) => (i === 0 ? l : `${l};q=${Math.max(0.1, 1 - i * 0.1).toFixed(1)}`))
		.join(","));
}

function makeId() {
	return Math.random().toString(36).slice(2, 10);
}

const nativeFrameElement = Object.getOwnPropertyDescriptor(window, "frameElement")?.get
	?? (Object.getOwnPropertyDescriptor(Window.prototype, "frameElement") as any)?.get;

function frameElementOf(win: Window): HTMLIFrameElement | null {
	try {
		// read through the parent realm's accessor so scramjet's trap in the child can't hide it
		return nativeFrameElement.call(win);
	} catch {
		return null;
	}
}

const nativeWindowName = Object.getOwnPropertyDescriptor(window, "name")?.get
	?? (Object.getOwnPropertyDescriptor(Window.prototype, "name") as any)?.get;

function realmOf(win: any): RealmState | undefined {
	try {
		return Object.prototype.hasOwnProperty.call(win, REALM) ? win[REALM] : undefined;
	} catch {
		return undefined;
	}
}

const COOKIE_KEY = "sjl:cookies";

// which proxied window a History object belongs to. pages often call a pushState borrowed
// from another (helper iframe) realm, so the realm that runs the call isn't the one whose
// url changes
const historyOwners = new WeakMap<object, { win: any; state: RealmState }>();

// ports handed to us come from proxied realms whose MessagePort methods scramjet has
// hooked; always drive them with this (unhooked) realm's natives
const portPost = MessagePort.prototype.postMessage;
const portStart = MessagePort.prototype.start;
const listen = EventTarget.prototype.addEventListener;
function onPort(port: MessagePort, fn: (data: any) => void) {
	listen.call(port, "message", (e: Event) => fn((e as MessageEvent).data));
	portStart.call(port);
}
const post = (port: MessagePort, data: any, transfer: Transferable[] = []) =>
	portPost.call(port, data, transfer);

/**
 * A stand-in for Storage: items are own properties (scramjet lists them with Object.keys),
 * the methods are inherited, like the real one.
 */
function memoryStorage(): object {
	const has = (o: object, k: string) => Object.prototype.hasOwnProperty.call(o, k);
	const proto = {
		getItem(k: string) {
			k = String(k);
			return has(this, k) ? (this as any)[k] : null;
		},
		setItem(k: string, v: string) {
			(this as any)[String(k)] = String(v);
		},
		removeItem(k: string) {
			delete (this as any)[String(k)];
		},
		clear() {
			for (const k of Object.keys(this)) delete (this as any)[k];
		},
		key(i: number) {
			return Object.keys(this)[i] ?? null;
		},
		get length() {
			return Object.keys(this).length;
		},
	};
	Object.defineProperty(proto, Symbol.toStringTag, { value: "Storage" });
	return Object.create(proto);
}

export class Controller {
	prefix: URL;
	transport: SwitchableTransport;
	handler: any;
	cookieJar: any;
	sjconfig: any;
	private workerBootUrl: string | null = null;
	/** every open tab (set by the browser UI), for window names */
	tabs: () => TabHost[] = () => [];
	/** localStorage for realms that can't have the real one (opaque origins); per tab for sessionStorage */
	private memoryLocal: object | null = null;
	private memorySession = new WeakMap<TabHost, object>();
	private cookieTimer: any = null;
	private liveRealms = 0;
	/** for debugging leaks: every realm we've adopted, weakly */
	private realmRefs = new Set<WeakRef<RealmState>>();

	private constructor(wisp: string, wispx: boolean) {
		this.prefix = new URL(PREFIX);
		this.transport = new SwitchableTransport(wisp, wispx);
	}

	static async create(wisp: string, wispx = true) {
		const ctrl = new Controller(wisp, wispx);
		await ctrl.init();
		return ctrl;
	}

	private async init() {
		// epoxy's wasm compiles and the wisp connection opens while scramjet loads
		this.transport.init().catch(() => {});
		const sj = await loadScramjet();
		this.sjconfig = {
			...sj.defaultConfig,
			flags: {
				...sj.defaultConfig.flags,
				// never let a failed hook take the whole page down
				allowFailedIntercepts: true,
				// we hand workers their code directly; no need for data: url wrapping
				encapsulateWorkers: false,
			},
		};
		this.cookieJar = new sj.CookieJar();
		try {
			const saved = localStorage.getItem(COOKIE_KEY);
			if (saved) this.cookieJar.load(saved);
		} catch {
			/* private mode etc */
		}

		this.handler = new (sj as any).ScramjetFetchHandler({
			crossOriginIsolated: self.crossOriginIsolated,
			context: this.makeContext(false),
			transport: this.transport,
			sendSetCookie: async () => this.persistCookies(),
			fetchBlobUrl: async (url: string) => sj.BareResponse.fromNativeResponse(await fetch(url)),
			fetchDataUrl: async (url: string) => sj.BareResponse.fromNativeResponse(await fetch(url)),
		});

		// srcdoc documents and the like bootstrap themselves by calling back up here
		Object.defineProperty(window, "__sjlAdopt", {
			value: (win: Window) => {
				const parent = win.parent as any;
				const parentState: RealmState | undefined = parent?.[REALM];
				if (parentState) this.adopt(win, parentState.tab, {});
			},
			enumerable: false,
		});
	}

	codecEncode = (url: string) => (url ? encodeURIComponent(url) : url);
	codecDecode = (url: string) => (url ? decodeURIComponent(url) : url);

	private makeContext(inject: boolean) {
		const codecEncode = this.codecEncode;
		const codecDecode = this.codecDecode;
		const adoptSnippet =
			"(function(){var f;try{for(var p=window.parent;;p=p.parent){if(p.__sjlAdopt){f=p.__sjlAdopt;break}if(p===p.parent)break}}catch(e){}f&&f(window)})()";
		const adoptSrc = "data:text/javascript;base64," + btoa(adoptSnippet);
		return {
			config: this.sjconfig,
			prefix: this.prefix,
			cookieJar: this.cookieJar,
			interface: {
				codecEncode,
				codecDecode,
				// top-level documents are adopted from outside before they are written, so
				// they need nothing injected. documents the browser loads by itself (srcdoc)
				// get a tiny script that asks us to adopt them.
				getInjectScripts: (_meta: any, _handler: any, _html: any, script: (s: string) => any) =>
					inject ? [script(adoptSrc)] : [],
				// workers are bootstrapped by src/realm/worker.js, not by injected imports
				getWorkerInjectScripts: () => "",
			},
		};
	}

	rewrite(url: string, base?: string) {
		const b = new URL(base || "about:blank", location.href);
		return $scramjet.rewriteUrl(url, this.makeContext(false), { origin: b, base: b } as any);
	}

	unrewrite(url: string) {
		return $scramjet.unrewriteUrl(url, { prefix: this.prefix, interface: { codecDecode: this.codecDecode } } as any);
	}

	isVirtual(url: string) {
		return typeof url === "string" && url.startsWith(this.prefix.href);
	}

	/** Virtual url for a real url typed by the user. */
	virtualFor(realUrl: string) {
		return this.prefix.href + this.codecEncode(new URL(realUrl).href);
	}

	persistCookies() {
		clearTimeout(this.cookieTimer);
		this.cookieTimer = setTimeout(() => {
			try {
				localStorage.setItem(COOKIE_KEY, this.cookieJar.dump());
			} catch {
				/* quota */
			}
		}, 300);
	}

	clearCookies() {
		this.cookieJar.clear();
		try {
			localStorage.removeItem(COOKIE_KEY);
		} catch {}
	}

	/**
	 * The service worker's fetch route, minus the service worker. Takes a request for a
	 * virtual url, runs it through scramjet's fetch handler (rewriting request headers,
	 * cookies, and the response body), follows redirects unless told not to.
	 */
	async serve(req: ServeRequest): Promise<ServeResponse> {
		const sj = $scramjet;
		const destination = req.destination ?? "";
		const headers = new Map<string, [string, string]>();
		for (const [k, v] of req.headers ?? []) headers.set(k.toLowerCase(), [k, v]);
		if (!headers.has("accept")) headers.set("accept", ["Accept", ACCEPT[destination] ?? "*/*"]);
		if (!headers.has("accept-language"))
			headers.set("accept-language", ["Accept-Language", acceptLanguage()]);
		if (!headers.has("user-agent")) headers.set("user-agent", ["User-Agent", navigator.userAgent]);
		if (destination === "document" || destination === "iframe")
			headers.set("upgrade-insecure-requests", ["Upgrade-Insecure-Requests", "1"]);
		let raw = [...headers.values()];

		let url = req.url;
		let method = (req.method || "GET").toUpperCase();
		let body = method === "GET" || method === "HEAD" ? null : req.body ?? null;
		let hops = 0;

		for (;;) {
			const res = await this.handler.handleFetch({
				rawUrl: new URL(url),
				rawReferrer: req.referrer || null,
				rawDestination: destination,
				mode: req.mode ?? "cors",
				referrer: req.referrer || "",
				method,
				body,
				cache: "default",
				initialHeaders: sj.ScramjetHeaders.fromRawHeaders(raw),
				rawClientUrl: req.clientUrl && this.isVirtual(req.clientUrl) ? new URL(req.clientUrl) : undefined,
				clientId: req.clientId || "",
			});

			const location = res.headers.get("location");
			if (req.redirect !== "manual" && REDIRECTS.includes(res.status) && location) {
				if (req.redirect === "error" || ++hops > 20) throw new TypeError("Failed to fetch");
				url = new URL(location, url).href;
				if (res.status === 303 || ((res.status === 301 || res.status === 302) && method === "POST")) {
					method = "GET";
					body = null;
					raw = raw.filter(([k]) => !/^content-(type|length)$/i.test(k));
				}
				// drop the redirect's body so its connection can be reused
				discardBody(res.body);
				continue;
			}

			return {
				status: res.status,
				statusText: res.statusText,
				headers: res.headers.toRawHeaders(),
				body: res.body,
				url,
				redirected: hops > 0,
			};
		}
	}

	/**
	 * Turn a same-origin window into a proxied realm: scramjet runtime, sink layer,
	 * hooked client. Idempotent per Window object (doc.open() keeps the Window, so a
	 * re-written document reuses the client and just refreshes its document state).
	 */
	/** the virtual url of a proxied window (see RealmState.virtualUrl) */
	currentUrl(win: any, state: RealmState): string {
		let href = "";
		try {
			href = win.location.href;
		} catch {}
		if (this.isVirtual(href)) return href;
		if (!state.virtualUrl) return href;
		// our tracked url, with whatever fragment the page navigated to since
		let hash = "";
		try {
			hash = win.location.hash;
		} catch {}
		const base = state.virtualUrl.split("#")[0];
		return hash ? base + "#" + this.codecEncode(hash.slice(1)) : base;
	}

	adopt(
		win: any,
		tab: TabHost,
		init: {
			initHeaders?: [string, string][];
			history?: any[];
			isTabTop?: boolean;
			clientId?: string;
			virtualUrl?: string;
		}
	): any {
		const existing: RealmState | undefined = Object.prototype.hasOwnProperty.call(win, REALM)
			? win[REALM]
			: undefined;
		if (existing) {
			existing.client.syncDocumentInit({
				initHeaders: init.initHeaders ?? [],
				history: init.history ?? [],
			});
			existing.tab = tab;
			if (existing.net.dead) {
				existing.net = new RealmNet(this.transport);
				this.liveRealms++;
			}
			if (init.virtualUrl) existing.virtualUrl = init.virtualUrl;
			if (init.isTabTop !== undefined) existing.isTabTop = init.isTabTop;
			if (init.clientId) existing.clientId = init.clientId;
			existing.sink.documentReset();
			return existing.client;
		}

		const frame = frameElementOf(win);
		if (frame && !frame.name) frame.name = "sjl-" + makeId();
		try {
			if (!win.name && frame) win.name = frame.name;
		} catch {}

		if (!win.$scramjet) new win.Function(SCRAMJET_SOURCE)();
		win.$scramjet.setWasm(WASM_BYTES);

		const state: RealmState = {
			tab,
			client: null,
			sink: null,
			net: new RealmNet(this.transport),
			clientId: init.clientId || makeId(),
			written: false,
			isTabTop: !!init.isTabTop,
			virtualUrl: init.virtualUrl ?? "",
		};
		Object.defineProperty(win, REALM, { value: state, enumerable: false, configurable: true });
		this.liveRealms++;
		this.realmRefs.add(new WeakRef(state));

		historyOwners.set(win.history, { win, state });
		const bridge = this.makeBridge(win, state);
		state.sink = new win.Function("bridge", SINK_SOURCE)(bridge);

		const client = new win.$scramjet.ScramjetClient(win, {
			context: this.makeContext(true),
			// its WebSockets are opened through the realm, so they close with it
			transport: RealmNet.transportFor(() => state.net, this.transport),
			sendSetCookie: async () => this.persistCookies(),
			shouldBlockMessageEvent: () => false,
			hookSubcontext: (sub: any) => this.adopt(sub, tab, {}),
			initHeaders: init.initHeaders ?? [],
			history: init.history ?? [],
		});
		state.client = client;
		// scramjet reads the page url from location.href; give it the tracked one instead
		const ctrl = this;
		const proto = Object.getPrototypeOf(client);
		const urlDesc = Object.getOwnPropertyDescriptor(proto, "url")!;
		const RealmURL = win.URL;
		Object.defineProperty(client, "url", {
			configurable: true,
			get() {
				const href = ctrl.currentUrl(win, state);
				return new RealmURL(ctrl.isVirtual(href) ? ctrl.unrewrite(href) : href);
			},
			// location.href = ..., location.pathname = ... and friends. Taken here instead of
			// letting the frame navigate to the virtual url and catching that: no real
			// navigation is started, and it works where the Navigation API has no events
			set(v) {
				const target = String(v).startsWith("#") ? String(v) : client.rewriteUrl(String(v), { navigateType: "location" });
				if (!ctrl.navigateVirtual(win, state, target, false)) urlDesc.set!.call(this, v);
			},
		});
		// location.assign / replace / reload (see the scramjet patches in runtime.ts)
		client.sjlNavigate = (target: string, replace: boolean) => ctrl.navigateVirtual(win, state, target, replace);
		client.sjlReload = () => {
			if (!state.net.dead) ctrl.navigateFrom(win, state, ctrl.currentUrl(win, state), { reload: true });
			return true;
		};
		// scramjet builds its import() trampoline from natives.Function; hand it ours so
		// dynamic imports of virtual urls get resolved to linked blob modules first
		client.natives.store["Function"] = state.sink.functionForScramjet;
		client.hook();
		state.sink.afterHook(client);
		return client;
	}

	private makeBridge(win: any, state: RealmState) {
		const ctrl = this;
		// a released realm's leftover promises and callbacks can still land here after its
		// document is gone; they must not touch the tab (title, icon, url, navigation) or
		// fetch into the next document's resources
		const live = () => !state.net.dead;
		const gone = () => Promise.resolve(null);
		const rc = (clientUrl?: string) => ({
			clientUrl,
			clientId: state.clientId,
			importMap: (entries: Record<string, string>) => state.sink?.addImportMap(entries),
		});
		return {
			prefix: this.prefix.href,
			prefixPath: this.prefix.pathname,
			hostOrigin: this.prefix.origin,
			blobOrigin: BLOB_ORIGIN,
			clientUrl: () => ctrl.currentUrl(win, state),
			// history.pushState/replaceState ran on some window's History (maybe not ours)
			historyChanged: (history: object, url: string | null, pushed: boolean) => {
				const owner = historyOwners.get(history) ?? { win, state };
				if (owner.state.net.dead) return;
				if (url && ctrl.isVirtual(url)) owner.state.virtualUrl = url;
				// also for a push without a url: that entry has the url the page is at now
				owner.state.sink?.rememberEntry(url && ctrl.isVirtual(url) ? url : ctrl.currentUrl(owner.win, owner.state));
				if (pushed && owner.state.isTabTop) owner.state.tab.historyPushed();
				if (owner.state.isTabTop) {
					try {
						owner.state.tab.urlChanged(ctrl.unrewrite(ctrl.currentUrl(owner.win, owner.state)));
					} catch {}
				}
			},
			// popstate: restore the url we recorded for the entry we landed on
			setVirtualUrl: (url: string) => {
				state.virtualUrl = url;
			},
			serve: async (req: ServeRequest) => state.net.guard(await ctrl.serve({ ...req, clientId: state.clientId })),
			// the realm's document is going away (pagehide)
			closed: () => ctrl.release(win),
			resolve: (url: string, kind: ResourceKind, clientUrl?: string) =>
				live() ? state.tab.resources.resolve(url, kind, rc(clientUrl)) : gone(),
			peek: (url: string, kind: ResourceKind) => (live() ? state.tab.resources.peek(url, kind) : null),
			resolveCss: (css: string, clientUrl?: string) =>
				live() ? state.tab.resources.resolveCss(css, rc(clientUrl)) : Promise.resolve(css),
			cachedCss: (css: string) => state.tab.resources.cachedCss(css),
			resolveBare: (spec: string) => state.tab.resources.resolveBare(spec),
			hasModuleLiterals: (js: string) => state.tab.resources.hasModuleLiterals(js),
			linkModule: (js: string, clientUrl?: string) =>
				state.tab.resources.linkModule(js, null, rc(clientUrl)),
			prepareSrcdoc: (html: string, clientUrl?: string) =>
				prepareHtml(ctrl, state.tab.resources, html, rc(clientUrl)),
			navigate: (url: string, init: NavInit) => live() && ctrl.navigateFrom(win, state, url, init),
			memoryStorage: (name: string) => {
				if (name === "localStorage") return (ctrl.memoryLocal ??= memoryStorage());
				let s = ctrl.memorySession.get(state.tab);
				if (!s) ctrl.memorySession.set(state.tab, (s = memoryStorage()));
				return s;
			},
			// a link/form/window.open target: the window it went to, or null for a new tab
			navigateTarget: (target: string, url: string | null, init: NavInit) =>
				live() ? ctrl.navigateTarget(win, state, target, url, init) : null,
			loadFrame: (iframe: HTMLIFrameElement, url: string, clientUrl?: string) =>
				live() && loadIntoFrame(ctrl, state.tab, iframe, url, { referrer: clientUrl }),
			open: (url: string | null, background: boolean, opener?: Window, name?: string) =>
				live() ? state.tab.open(url, { background, opener, name }) : null,
			download: (url: string, filename?: string) => downloadResource(ctrl, state.tab, url, filename),
			unrewrite: (url: string) => ctrl.unrewrite(url),
			rewrite: (url: string, base: string) => ctrl.rewrite(url, base),
			urlChanged: () => {
				if (!state.isTabTop || !live()) return;
				try {
					state.tab.urlChanged(ctrl.unrewrite(ctrl.currentUrl(win, state)));
				} catch {}
			},
			loaded: () => state.isTabTop && live() && state.tab.loaded(),
			historyPushed: () => state.isTabTop && live() && state.tab.historyPushed(),
			titleChanged: (title: string) => state.isTabTop && live() && state.tab.titleChanged(title),
			iconChanged: (url: string | null) => state.isTabTop && live() && state.tab.iconChanged(url),
			shortcut: (e: any) => state.tab.shortcut(e),
			frameElementOf,
			// everything a dedicated worker needs to bootstrap its own proxied realm
			sinkSource: SINK_SOURCE,
			workerRpc: (port: MessagePort) => ctrl.workerRpc(port, state),
			workerBoot: () => ({
				scramjetSource: SCRAMJET_SOURCE,
				bootUrl: ctrl.getWorkerBootUrl(),
				wasm: WASM_BYTES,
				sjconfig: ctrl.sjconfig,
				prefix: ctrl.prefix.href,
				cookies: ctrl.cookieJar.dump(),
			}),
		};
	}

	/**
	 * A realm's document is gone: close its sockets, cut its streams, close its workers'
	 * ports, and forget its scramjet client record. Safe to call more than once.
	 */
	releaseRealm(state: RealmState) {
		if (state.net.dead) return;
		state.net.close();
		this.liveRealms--;
		// a tab's top realm shares the tab's client id, which lives as long as the tab
		if (state.clientId !== state.tab.clientId) this.handler.trackedClients.delete(state.clientId);
	}

	/**
	 * Release the realm of a window that's going away, and those of the frames inside it
	 * (not every frame document gets a pagehide of its own, e.g. never-navigated about:blank).
	 */
	release(win: any) {
		if (!win) return;
		let state: RealmState | undefined;
		let frames: any[] = [];
		try {
			state = Object.prototype.hasOwnProperty.call(win, REALM) ? win[REALM] : undefined;
			frames = Array.from({ length: win.frames.length }, (_, i) => win.frames[i]);
		} catch {}
		if (state) this.releaseRealm(state);
		for (const f of frames) this.release(f);
	}

	/** Realms that are still open, for tracking down leaks: `__sjl.ctrl.openRealms()`. */
	openRealms() {
		const out: Array<{ url: string; tabTop: boolean; clientId: string }> = [];
		for (const ref of this.realmRefs) {
			const st = ref.deref();
			if (!st) this.realmRefs.delete(ref);
			else if (!st.net.dead) out.push({ url: st.virtualUrl && this.unrewrite(st.virtualUrl), tabTop: st.isTabTop, clientId: st.clientId });
		}
		return out;
	}

	forgetClient(clientId: string) {
		this.handler.trackedClients.delete(clientId);
	}

	/** Numbers for spotting leaks: `__sjl.ctrl.stats()` in the app's console. */
	stats() {
		return {
			realms: this.liveRealms,
			realmSockets: realmSocketCount(),
			transportSockets: this.transport.stats.sockets,
			blobs: liveBlobCount(),
			trackedClients: this.handler.trackedClients.size,
			...this.transport.stats,
		};
	}

	getWorkerBootUrl() {
		this.workerBootUrl ??= URL.createObjectURL(
			new Blob([WORKER_BOOT_SOURCE], { type: "text/javascript" })
		);
		return this.workerBootUrl;
	}

	/** Requests from a proxied worker (it has no bridge object, only a MessagePort). */
	workerRpc(port: MessagePort, state: RealmState) {
		const rc = { clientId: state.clientId };
		state.net.addPort(port);
		onPort(port, async (data) => {
			const { id, op, args } = data;
			try {
				let value: any;
				let transfer: Transferable[] = [];
				switch (op) {
					case "serve": {
						const r = state.net.guard(await this.serve({ ...args, clientId: state.clientId }));
						let body = r.body;
						if (body instanceof Blob) body = await body.arrayBuffer();
						value = { ...r, body };
						if (body instanceof ReadableStream || body instanceof ArrayBuffer) transfer = [body];
						try {
							post(port, { id, ok: true, value }, transfer);
						} catch {
							// no transferable streams here: buffer it
							value.body = await new Response(body).arrayBuffer();
							post(port, { id, ok: true, value }, [value.body]);
						}
						return;
					}
					case "resolve":
						value = await state.tab.resources.resolve(args.url, args.kind, { ...rc, clientUrl: args.clientUrl });
						break;
					case "resolveWorker":
						value = await state.tab.resources.resolveWorker(args.url, args.isModule, rc);
						break;
					case "connect":
						this.connectForWorker(state.net, args.url, args.protocols, args.headers, args.port);
						value = true;
						break;
					case "setCookies":
						for (const e of args) this.cookieJar.setCookies(e.cookie, new URL(e.url));
						this.persistCookies();
						value = true;
						break;
					default:
						throw new Error("unknown op " + op);
				}
				post(port, { id, ok: true, value }, transfer);
			} catch (e) {
				post(port, { id, ok: false, error: String(e) });
			}
		});
	}

	private connectForWorker(net: RealmNet, url: string, protocols: string[], headers: [string, string][], port: MessagePort) {
		net.addPort(port);
		const [send, close] = net.connect(
			new URL(url),
			protocols,
			headers,
			(protocol, extensions) => post(port, { type: "open", protocol, extensions }),
			(data) => post(port, { type: "data", data }, data instanceof ArrayBuffer ? [data] : []),
			(code, reason) => post(port, { type: "close", code, reason }),
			(error) => post(port, { type: "error", error })
		);
		onPort(port, (data) => {
			if (data.type === "data") send(data.data);
			else if (data.type === "close") close(data.code, data.reason);
		});
	}

	/** A proxied window asked to navigate itself (or its tab) somewhere. */
	navigateFrom(win: any, state: RealmState | undefined, url: string, init: NavInit) {
		if (state?.isTabTop) {
			state.tab.navigate(url, init);
			return;
		}
		const frame = frameElementOf(win);
		const tab = state?.tab ?? this.tabOf(frame);
		if (frame && tab) loadIntoFrame(this, tab, frame, url, init);
	}

	/** the tab a frame element belongs to (a frame whose document we never adopted) */
	private tabOf(frame: HTMLIFrameElement | null): TabHost | undefined {
		for (let w: any = frame?.ownerDocument?.defaultView; w; w = w === w.parent ? null : w.parent) {
			const st = realmOf(w);
			if (st) return st.tab;
		}
		return undefined;
	}

	/**
	 * A page navigates its own window to `target` (a virtual url, or anything scramjet
	 * produced from what the page assigned). Returns false when that isn't ours to handle
	 * (javascript:, about:), so the real location gets it.
	 */
	navigateVirtual(win: any, state: RealmState, target: string, replace: boolean): boolean {
		// scramjet leaves a bare "#frag" alone
		if (target.startsWith("#")) return this.navigateFragment(win, state, target, replace);
		if (!this.isVirtual(target)) return false;
		if (state.net.dead) return true;
		const to = this.unrewrite(target);
		const from = this.unrewrite(this.currentUrl(win, state));
		const hashAt = to.indexOf("#");
		// only the fragment changes: same document, like a browser does it
		if (hashAt !== -1 && to.slice(0, hashAt) === from.split("#")[0] && this.navigateFragment(win, state, to.slice(hashAt), replace))
			return true;
		this.navigateFrom(win, state, target, { replace, referrer: this.currentUrl(win, state) });
		return true;
	}

	/** A same-document fragment navigation (done by the realm's sink layer, see goFragment). */
	private navigateFragment(win: any, state: RealmState, hash: string, replace: boolean): boolean {
		return !!state.sink?.goFragment?.(hash, replace);
	}

	/**
	 * Navigate the window a link, form or window.open() call targets, the way a browser
	 * resolves the name: _self, _parent, _top, or a frame/tab window by name. Returns that
	 * window, or null when no window has the name (the caller opens a new tab then).
	 */
	navigateTarget(win: any, state: RealmState, target: string, url: string | null, init: NavInit): Window | null {
		const t = target.toLowerCase();
		let dest: any = null;
		if (t === "" || t === "_self") dest = win;
		else if (t === "_parent") dest = state.isTabTop ? win : win.parent;
		else if (t === "_top") dest = state.tab.topWindow() ?? win;
		else if (t !== "_blank") {
			// window names are global: this tab's frames first, then every other tab
			dest = this.findNamed(state.tab.topWindow(), target);
			for (const tab of this.tabs()) if (!dest && tab !== state.tab) dest = this.findNamed(tab.topWindow(), target);
		}
		if (!dest) return null;
		// window.open("", name) only looks the window up
		if (url) this.navigateFrom(dest, realmOf(dest), url, init);
		return dest;
	}

	private findNamed(root: any, name: string): Window | null {
		if (!root) return null;
		try {
			if (nativeWindowName.call(root) === name) return root;
			for (let i = 0; i < root.frames.length; i++) {
				const hit = this.findNamed(root.frames[i], name);
				if (hit) return hit;
			}
		} catch {}
		return null;
	}
}
