// Loads the pieces every realm needs: the scramjet IIFE source, its rewriter wasm,
// and a wisp transport. The parent page evaluates scramjet once for itself (it runs
// the ScramjetFetchHandler that the service worker used to host), and hands the same
// source to every proxied frame so each realm gets its own hooked copy.

import scramjetRaw from "@sj-dist/scramjet.js?raw";
import scramjetWasmUrl from "@sj-dist/scramjet.wasm?url";
import initEpoxy, { EpoxyClient, EpoxyClientOptions, EpoxyHandlers } from "@epoxy";
import type {
	ProxyTransport,
	RawHeaders,
	TransferrableResponse,
} from "@mercuryworkshop/proxy-transports";

/** Apply a patch to the scramjet source; warn (and leave it unpatched) if it no longer matches. */
function patch(src: string, name: string, re: RegExp, to: string | ((...m: string[]) => string), count = 1) {
	const found = src.match(new RegExp(re.source, re.flags.includes("g") ? re.flags : re.flags + "g"))?.length ?? 0;
	if (found !== count) {
		console.warn(`[sjl] scramjet patch "${name}" didn't apply (${found} matches, expected ${count})`);
		return src;
	}
	return src.replace(re, to as any);
}

function patchScramjet(src: string) {
	// scramjet's getRewriter() runs `initSync({ module: new WebAssembly.Module(bytes) })` on
	// every js rewrite (each script, eval, new Function...). initSync returns early after the
	// first call, but the module argument is compiled first anyway. Only build it once.
	src = patch(
		src,
		"wasm init",
		/(\(0,[\w$]+\.[\w$]+\))\(\{module:new WebAssembly\.Module\(([\w$]+)\)\}\);/,
		(_, init, bytes) => `${bytes}.sjlInit||(${init}({module:new WebAssembly.Module(${bytes})}),${bytes}.sjlInit=1);`
	);

	// Blob urls. Scramjet shows a page its blob urls under the site's origin
	// (blob:https://site/<id>) and turns them back into real ones with its prefix's origin.
	// At a null origin the real ones are blob:null/<id>, which URL can't parse and which
	// don't carry the prefix's origin, so both directions go through these helpers instead.
	src = patch(
		src,
		"blob to page",
		/new ([\w$]+\.[\w$]+)\(([\w$]+)\.substring\(5\)\);return"blob:"\+([\w$]+)\.origin\.origin\+([\w$]+)\.pathname/,
		(_, URL_, e, r, i) => `new ${URL_}(__sjlBlobUrl(${e}));return"blob:"+${r}.origin.origin+${i}.pathname`
	);
	src = patch(
		src,
		"blob from page",
		/new ([\w$]+\.[\w$]+)\(([\w$]+)\.substring\(5\)\);return"blob:"\+([\w$]+)\.prefix\.origin\+([\w$]+)\.pathname/,
		(_, URL_, e, _t, i) => `new ${URL_}(__sjlBlobUrl(${e}));return"blob:"+__sjlBlobOrigin+${i}.pathname`
	);

	// location.assign/replace/reload call the real methods with a virtual url. Let the
	// controller take them (client.sjlNavigate / sjlReload) so pages navigate even where the
	// Navigation API's events are switched off (documents with an opaque origin).
	src = patch(
		src,
		"location proxy client",
		/(function [\w$]+\(([\w$]+),([\w$]+)\)\{)(let [\w$]+=[\w$]+\.iswindow\?\3\.Location:\3\.WorkerLocation)/,
		(_, head, client, _g, rest) => `${head}var __sjlClient=${client};${rest}`
	);
	src = patch(
		src,
		"location assign/replace",
		/\.(assign|replace)=new Proxy\(([\w$]+)\.location\.\1,\{apply\(([\w$]+),([\w$]+),([\w$]+)\)\{\5\[0\]=([\w$]+)\.rewriteUrl\(\5\[0\]\),/g,
		(_, m, g, a, b, args, client) =>
			`.${m}=new Proxy(${g}.location.${m},{apply(${a},${b},${args}){${args}[0]=${client}.rewriteUrl(${args}[0]);` +
			`if(__sjlClient.sjlNavigate&&__sjlClient.sjlNavigate(${args}[0],${m === "replace"}))return;`,
		2
	);
	src = patch(
		src,
		"location reload",
		/\.reload=new Proxy\(([\w$]+)\.location\.reload,\{apply\(([\w$]+),([\w$]+),([\w$]+)\)\{/,
		(_, g, a, b, c) => `.reload=new Proxy(${g}.location.reload,{apply(${a},${b},${c}){if(__sjlClient.sjlReload&&__sjlClient.sjlReload())return;`
	);

	// evaluated first thing in every realm, before any hooks: what this realm's real blob
	// urls look like (blob:<origin>/<id>, origin "null" when opaque)
	const prelude =
		"var __sjlBlobOrigin=(function(){var u=URL.createObjectURL(new Blob([]));URL.revokeObjectURL(u);return u.slice(5,u.lastIndexOf('/'))})();" +
		"var __sjlBlobUrl=function(u){u=u.substring(5);return u.slice(0,5)==='null/'?'http://null.invalid'+u.slice(4):u};\n";
	return prelude + src;
}

// the bundle ends with a sourceMappingURL comment pointing at a file we don't ship
export const SCRAMJET_SOURCE =
	patchScramjet(scramjetRaw.replace(/\/\/# sourceMappingURL=.*$/m, "")) + "\n//# sourceURL=scramjet.js";

export let WASM_BYTES: Uint8Array;

export async function loadScramjet() {
	if (!(globalThis as any).$scramjet) {
		new Function(SCRAMJET_SOURCE)();
	}
	const resp = await fetch(scramjetWasmUrl);
	WASM_BYTES = new Uint8Array(await resp.arrayBuffer());
	$scramjet.setWasm(WASM_BYTES);
	return $scramjet;
}

export function normalizeWispUrl(input: string): string {
	let url = input.trim();
	// no server set yet: init() says so
	if (!url) return "";
	if (!/^[a-z]+:\/\//i.test(url)) url = "wss://" + url;
	const u = new URL(url);
	if (u.protocol === "https:") u.protocol = "wss:";
	if (u.protocol === "http:") u.protocol = "ws:";
	// wisp servers route on the path prefix and nearly all of them expect the slash
	if (!u.pathname.endsWith("/")) u.pathname += "/";
	return u.href;
}

/** Copy a view's bytes into an ArrayBuffer of this realm. */
const copyView = (v: ArrayBufferView) => new Uint8Array(v.buffer, v.byteOffset, v.byteLength).slice().buffer;

/**
 * Request bodies built inside proxied frames are that realm's ArrayBuffers/Blobs/streams,
 * which fail epoxy's instanceof checks here. Copy them into this realm.
 */
async function normalizeBody(body: any): Promise<any> {
	if (body == null || typeof body === "string") return body;
	const tag = Object.prototype.toString.call(body);
	if (tag === "[object ArrayBuffer]") return body instanceof ArrayBuffer ? body : new Uint8Array(body).slice().buffer;
	if (ArrayBuffer.isView(body)) return copyView(body);
	if (tag === "[object Blob]" || tag === "[object File]" || tag === "[object ReadableStream]" ||
		tag === "[object FormData]" || tag === "[object URLSearchParams]") {
		return new Response(body).arrayBuffer();
	}
	return body;
}

/** epoxy errors meaning the wisp connection (not just one request) is gone or never came up */
const DEAD_MUX = /MuxTaskEnded|Multiplexor task ended|WsClosed|socket (was )?closed|mux.*closed|WebSocket failed to connect|did not open/i;
/** the websocket to the wisp server couldn't be opened at all */
const WS_FAILED = /WebSocket failed to connect|did not open/i;

/**
 * WebSocket payloads come from proxied realms too. epoxy checks them with instanceof, so a
 * frame's ArrayBuffer or Blob would not be recognized as binary; copy into this realm.
 */
function normalizeWsData(data: any): any {
	if (typeof data === "string") return data;
	const tag = Object.prototype.toString.call(data);
	if (tag === "[object ArrayBuffer]") return data instanceof ArrayBuffer ? data : new Uint8Array(data).slice().buffer;
	if (ArrayBuffer.isView(data)) return copyView(data);
	if (tag === "[object Blob]" || tag === "[object File]") return data instanceof Blob ? data : new Blob([data]);
	return data;
}

/**
 * epoxy takes headers as an object, so repeated names have to be combined; joining with ", "
 * is what HTTP defines for that (cookies use "; ").
 */
function headerObject(headers: RawHeaders): Record<string, string> {
	const out: Record<string, string> = {};
	const names = new Map<string, string>();
	for (const [k, v] of headers) {
		const lower = k.toLowerCase();
		const key = names.get(lower);
		if (key === undefined) {
			names.set(lower, k);
			out[k] = v;
		} else out[key] += (lower === "cookie" ? "; " : ", ") + v;
	}
	return out;
}

let epoxyReady: Promise<void> | null = null;

function makeClient(wispUrl: string, wispx: boolean) {
	const options = new EpoxyClientOptions();
	options.user_agent = navigator.userAgent;
	// WispX, falling back to v2/v1 by itself when the server answers like an older one
	options.wisp_v2 = wispx;
	options.wispx = wispx;
	return new EpoxyClient(wispUrl, options);
}

/** Can a websocket without a subprotocol reach the server? (it rejected the one with "wispx") */
function plainWebSocketOpens(url: string): Promise<boolean> {
	return new Promise((resolve) => {
		let ws: WebSocket;
		try {
			ws = new WebSocket(url);
		} catch {
			return resolve(false);
		}
		const done = (ok: boolean) => {
			clearTimeout(timer);
			ws.onopen = ws.onerror = ws.onclose = null;
			try {
				ws.close();
			} catch {}
			resolve(ok);
		};
		const timer = setTimeout(() => done(false), 8000);
		ws.onopen = () => done(true);
		ws.onerror = ws.onclose = () => done(false);
	});
}

export type WispStatus = "connecting" | "ready" | "error";

/**
 * The ProxyTransport every realm uses: epoxy (TLS in the browser) over one multiplexed wisp
 * connection. Scramjet clients hold on to the transport they were created with, so switching
 * wisp servers from settings works by swapping the epoxy client behind this object instead of
 * rebuilding every realm.
 */
export class SwitchableTransport implements ProxyTransport {
	private client: EpoxyClient | null = null;
	private initPromise: Promise<void> | null = null;
	/** the wisp connection being opened right after init; requests wait for it */
	private warming: Promise<void> | null = null;
	wispUrl: string;
	/** ask for WispX (on by default) */
	wispx: boolean;
	/** this server refused the WispX subprotocol; we're talking plain Wisp v1 to it */
	downgraded = false;
	onstatus: (status: WispStatus, detail?: string) => void = () => {};

	constructor(wispUrl: string, wispx = true) {
		this.wispUrl = normalizeWispUrl(wispUrl);
		this.wispx = wispx;
	}

	get ready() {
		return !!this.client;
	}

	/** The protocol in use, for the settings panel. */
	get protocolLabel() {
		if (!this.wispx) return "Wisp v1";
		return this.downgraded ? "Wisp v1 (server doesn't offer WispX)" : "WispX";
	}

	init(): Promise<void> {
		this.initPromise ??= (async () => {
			this.onstatus("connecting");
			try {
				if (!this.wispUrl) throw new Error("No wisp server is set. Add one in the menu (⋮ → Settings).");
				epoxyReady ??= initEpoxy();
				await epoxyReady;
				const client = makeClient(this.wispUrl, this.wispx && !this.downgraded);
				this.client = client;
				this.warming = this.warm(client);
			} catch (e) {
				this.initPromise = null;
				this.onstatus("error", String(e));
				throw e;
			}
		})();
		return this.initPromise;
	}

	/**
	 * Open the wisp connection now instead of on the first request, so the first page load
	 * doesn't also wait for the websocket (and, for WispX, the HELLO exchange). If the server
	 * refuses the WispX subprotocol, which a browser can't distinguish from an unreachable
	 * server, check with a plain websocket and fall back to Wisp v1.
	 */
	private async warm(client: EpoxyClient): Promise<void> {
		try {
			await client.replace_stream_provider();
			if (this.client === client) this.onstatus("ready");
		} catch (e) {
			if (this.client !== client) return;
			const msg = String(e);
			if (this.wispx && !this.downgraded && WS_FAILED.test(msg) && (await plainWebSocketOpens(this.wispUrl))) {
				if (this.client !== client) return;
				console.info("[sjl] the wisp server doesn't accept WispX; using Wisp v1");
				this.downgraded = true;
				const v1 = makeClient(this.wispUrl, false);
				this.client = v1;
				return this.warm(v1);
			}
			this.onstatus("error", msg);
		}
	}

	private async ensureClient(): Promise<EpoxyClient> {
		// (re)connect if needed: the server may have been switched in settings meanwhile
		if (!this.client) await this.init();
		const warming = this.warming;
		if (warming) {
			await warming;
			if (this.warming === warming) this.warming = null;
		}
		return this.client!;
	}

	/** Switch wisp servers (settings). */
	setWisp(url: string, wispx = this.wispx) {
		this.wispUrl = normalizeWispUrl(url);
		this.wispx = wispx;
		this.downgraded = false;
		this.client = null;
		this.warming = null;
		this.initPromise = null;
		return this.init();
	}

	private async fetchOnce(
		client: EpoxyClient,
		remote: URL,
		method: string,
		body: any,
		headers: RawHeaders
	): Promise<TransferrableResponse> {
		const res: any = await client.fetch(remote.href, {
			method,
			body,
			headers: headerObject(headers),
			redirect: "manual",
		});
		const out: RawHeaders = [];
		for (const [key, value] of Object.entries(res.rawHeaders) as [string, string | string[]][]) {
			if (Array.isArray(value)) for (const v of value) out.push([key, v]);
			else out.push([key, value]);
		}
		return { body: res.body!, headers: out, status: res.status, statusText: res.statusText };
	}

	async request(
		remote: URL,
		method: string,
		body: BodyInit | null,
		headers: RawHeaders,
		signal: AbortSignal | undefined
	): Promise<TransferrableResponse> {
		body = await normalizeBody(body);
		// a POST that may have reached the server must not be sent twice; only retry it when
		// the failure happened before the request went out
		const idempotent = !/^(POST|PATCH)$/i.test(method);
		// epoxy doesn't retry when an upstream recycles an http/2 connection (GOAWAY) or a
		// pooled connection died. requests caught in that were never processed, so retry.
		for (let attempt = 0; ; attempt++) {
			// retries get their own copy of the body in case epoxy consumed the last one
			const attemptBody = attempt && body instanceof ArrayBuffer ? body.slice(0) : body;
			try {
				const client = await this.ensureClient();
				const r = await this.fetchOnce(client, remote, method, attemptBody, headers);
				if (attempt) this.stats.recovered++;
				return r;
			} catch (e) {
				const msg = String(e);
				const beforeSend = /Error\(Connect/.test(msg) || WS_FAILED.test(msg);
				if (DEAD_MUX.test(msg) && (idempotent || beforeSend) && attempt < 4 && !signal?.aborted) {
					// the wisp connection itself is gone (server restart, network change, sleep).
					// reconnect and go again; if the server isn't back yet, wait a little first
					this.stats.retries++;
					if (!(await this.reconnect())) await new Promise((r) => setTimeout(r, 500 * 2 ** attempt));
					continue;
				}
				// only a request that died on an already-open connection is worth retrying.
				// connect/handshake failures (the wisp server refusing a host, e.g. ad domains)
				// fail the same way every time
				const connectionError =
					!beforeSend &&
					(idempotent
						? /GoAway|connection closed|connection reset|IncompleteMessage|ChannelClosed|broken pipe|SendRequest/i
						: /GoAway/i
					).test(msg);
				if (!connectionError || attempt >= 4 || signal?.aborted) {
					this.stats.failed++;
					this.stats.lastError = msg;
					throw e;
				}
				this.stats.retries++;
				// give hyper a moment to drop the dead connection from its pool. (never reset
				// the whole wisp connection here: that would kill every other open stream,
				// e.g. a playing video's segment downloads)
				await new Promise((r) => setTimeout(r, 100 * 2 ** attempt));
			}
		}
	}

	stats = { retries: 0, recovered: 0, failed: 0, lastError: "", sockets: 0, reconnects: 0 };

	private reconnecting: Promise<boolean> | null = null;
	private lastReconnect = 0;

	/**
	 * Replace a dead wisp connection. Every request that hit the dead one shares a single
	 * reconnect; if one just failed, don't hammer the server: report failure instead.
	 */
	reconnect(): Promise<boolean> {
		if (this.reconnecting) return this.reconnecting;
		if (performance.now() - this.lastReconnect < 1000) return Promise.resolve(false);
		this.reconnecting = (async () => {
			this.onstatus("connecting");
			try {
				const client = await this.ensureClient();
				await client.replace_stream_provider();
				this.stats.reconnects++;
				this.onstatus("ready");
				return true;
			} catch (e) {
				this.onstatus("error", String(e));
				return false;
			} finally {
				this.lastReconnect = performance.now();
				this.reconnecting = null;
			}
		})();
		return this.reconnecting;
	}

	connect(
		url: URL,
		protocols: string[],
		requestHeaders: RawHeaders,
		onopen: (protocol: string, extensions: string) => void,
		onmessage: (data: Blob | ArrayBuffer | string) => void,
		onclose: (code: number, reason: string) => void,
		onerror: (error: string) => void
	): [
		(data: Blob | ArrayBuffer | string) => void,
		(code: number, reason: string) => void,
	] {
		// connect is synchronous in the interface. Sends and the close run in order on a chain
		// that starts once the socket exists (a Blob has to be read first; it must not let a
		// later message overtake it)
		let socket: any = null;
		let start!: () => void;
		let chain = new Promise<void>((r) => (start = r));
		const then = (fn: () => any) => {
			chain = chain.then(() => (socket ? fn() : undefined)).catch(() => {});
		};
		let closed = false;
		let counted = true;
		this.stats.sockets++;
		const done = () => {
			if (counted) (counted = false), this.stats.sockets--;
		};
		const fail = (e: unknown, reported: boolean) => {
			done();
			start();
			// a browser follows a failed connection's error with a close event; pages that
			// reconnect usually do it from onclose
			if (!reported) onerror(String(e));
			if (!closed) (closed = true), onclose(1006, "");
		};
		this.ensureClient().then(
			(client) => {
				if (closed) return start();
				const handlers = new EpoxyHandlers(
					// epoxy doesn't report the selected protocol/extensions or the close code
					() => !closed && onopen("", ""),
					() => {
						done();
						if (!closed) (closed = true), onclose(1000, "");
					},
					(error: any) => {
						// the page will reconnect its socket; make sure there's a wisp connection for it
						if (DEAD_MUX.test(String(error))) this.reconnect();
						onerror(String(error));
					},
					(data: Uint8Array | string) => {
						if (typeof data === "string") return onmessage(data);
						onmessage(data.byteOffset === 0 && data.byteLength === data.buffer.byteLength ? (data.buffer as ArrayBuffer) : copyView(data));
					}
				);
				client.connect_websocket(handlers, url.href, protocols, headerObject(requestHeaders)).then(
					(ws) => {
						socket = ws;
						start();
					},
					// epoxy has already called onerror for this
					(e) => fail(e, true)
				);
			},
			(e) => fail(e, false)
		);
		return [
			(data) => {
				data = normalizeWsData(data);
				then(async () => socket.send(data instanceof Blob ? await data.arrayBuffer() : data));
			},
			(code, reason) => {
				if (socket || !closed) then(() => socket.close(code, reason || ""));
				if (!socket && !closed) {
					// not connected yet: the page sees the close right away, and the socket, if
					// it still opens, is closed as soon as it does
					closed = true;
					done();
					onclose(code, reason);
				}
			},
		];
	}
}
