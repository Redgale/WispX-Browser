// Sink layer: runs INSIDE a proxied realm (window or worker), evaluated as
//   new realm.Function("bridge", SOURCE)(bridge)
// before scramjet hooks that realm. Scramjet rewrites urls to the virtual /~/sj/ space and
// then calls what it believes are native APIs (fetch, XMLHttpRequest, setAttribute, ...).
// Normally a service worker answers the resulting requests. Here the "natives" scramjet
// captures are these wrappers, which answer virtual urls through the controller instead:
// fetch/XHR/EventSource get real responses, and anything the browser would load by itself
// (img src, <script src>, stylesheets, module imports, iframes) gets a blob: url or is
// loaded by the controller. Everything else falls through to the real native.
//
// Plain JS on purpose: it is evaluated in the target realm so every object, error and
// promise it creates belongs to that realm.
"use strict";

const B = bridge;
const win = globalThis;
const PREFIX = B.prefix;
const IS_WINDOW = typeof win.Window === "function" && win instanceof win.Window;
const doc = IS_WINDOW ? win.document : null;

// ---- snapshot everything we use; scramjet will replace many of these globals ----
const _Object = Object;
const defineProperty = Object.defineProperty;
const getDesc = Object.getOwnPropertyDescriptor;
const apply = Reflect.apply;
const _Promise = Promise;
const _Error = Error;
const _TypeError = TypeError;
const _DOMException = DOMException;
const _URL = URL;
const _URLSearchParams = URLSearchParams;
const _String = String;
const _Map = Map;
const _WeakMap = WeakMap;
const _Set = Set;
const _WeakSet = WeakSet;
const _JSON = JSON;
const _Blob = Blob;
const _Uint8Array = Uint8Array;
const _TextDecoder = TextDecoder;
const _TextEncoder = TextEncoder;
const _Response = Response;
const _Request = Request;
const _Headers = Headers;
const _EventTarget = EventTarget;
const _Event = Event;
const _MessageEvent = MessageEvent;
const _ProgressEvent = typeof ProgressEvent === "function" ? ProgressEvent : Event;
const _setTimeout = setTimeout;
const _clearTimeout = clearTimeout;
const _MessageChannel = MessageChannel;
const _Function = Function;
const addListener = EventTarget.prototype.addEventListener;
const dispatch = EventTarget.prototype.dispatchEvent;
const nativeFetch = win.fetch;
const nativeEval = win.eval;
const requestUrl = getDesc(Request.prototype, "url").get;
const requestSignal = getDesc(Request.prototype, "signal").get;

const INVALID = "about:invalid";
// what this realm's own blob: urls look like (blob:<origin>/<id>); "null" at an opaque origin
const BLOB_ORIGIN = (() => {
	const u = URL.createObjectURL(new Blob([]));
	URL.revokeObjectURL(u);
	return u.slice(5, u.lastIndexOf("/"));
})();
const isVirtual = (v) => typeof v === "string" && v.startsWith(PREFIX);
const hasVirtual = (v) => typeof v === "string" && v.includes(PREFIX);
const clientUrl = () => (B.clientUrl ? B.clientUrl() : win.location.href);
// bridge promises come from the parent realm; re-wrap so callers get our realm's Promise
const local = (p) => new _Promise((res, rej) => p.then(res, rej));
// a response body nobody will read: cancel it so its connection frees up
const discard = (body) => {
	try {
		if (body && typeof body.cancel === "function" && !body.locked) body.cancel().catch(() => {});
	} catch {}
};
const failedFetch = (e) => {
	if (e && e.name === "AbortError") return e;
	const err = new _TypeError("Failed to fetch");
	try {
		err.cause = e;
	} catch {}
	return err;
};

// ----------------------------------------------------------------------------
// storage: at an opaque origin (data:, blob:null) reading localStorage/sessionStorage
// throws, and scramjet wraps both while it hooks the realm. Give it an in-memory store kept
// by the controller instead, so a site's storage lasts for the session.
// ----------------------------------------------------------------------------

if (IS_WINDOW && B.memoryStorage) {
	for (const name of ["localStorage", "sessionStorage"]) {
		try {
			win[name];
			continue;
		} catch {}
		try {
			defineProperty(win, name, { value: B.memoryStorage(name), writable: true, configurable: true, enumerable: true });
		} catch {}
	}
}

// scramjet's client reads navigator.serviceWorker when it's created (and then removes it from
// the page); where reading it throws (some opaque origins), shadow it until then
let unshadowServiceWorker = () => {};
try {
	win.navigator.serviceWorker;
} catch {
	try {
		const nav = win.navigator;
		defineProperty(nav, "serviceWorker", { value: undefined, configurable: true });
		unshadowServiceWorker = () => {
			unshadowServiceWorker = () => {};
			try {
				delete nav.serviceWorker;
			} catch {}
		};
	} catch {}
}

// ----------------------------------------------------------------------------
// network: fetch
// ----------------------------------------------------------------------------

const NULL_BODY = [101, 103, 204, 205, 304];
const responseMeta = new _WeakMap();

function makeResponse(r, method) {
	const headers = new _Headers();
	for (const [k, v] of r.headers) {
		try {
			headers.append(k, v);
		} catch {}
	}
	const status = r.status >= 200 && r.status <= 599 ? r.status : 200;
	const body = NULL_BODY.includes(status) || method === "HEAD" ? null : r.body;
	if (body === null) discard(r.body);
	let resp;
	try {
		resp = new _Response(body, { status, statusText: r.statusText || "", headers });
	} catch {
		resp = new _Response(body, { status, headers });
	}
	responseMeta.set(resp, { url: r.url, redirected: !!r.redirected });
	return resp;
}

for (const [prop, key] of [
	["url", "url"],
	["redirected", "redirected"],
]) {
	const d = getDesc(_Response.prototype, prop);
	if (!d || !d.get) continue;
	defineProperty(_Response.prototype, prop, {
		...d,
		get() {
			const m = responseMeta.get(this);
			return m ? m[key] : apply(d.get, this, []);
		},
	});
}
{
	const clone = _Response.prototype.clone;
	_Response.prototype.clone = function () {
		const c = apply(clone, this, arguments);
		const m = responseMeta.get(this);
		if (m) responseMeta.set(c, m);
		return c;
	};
}

function abortable(p, signal) {
	if (!signal) return p;
	return new _Promise((res, rej) => {
		if (signal.aborted) return rej(signal.reason);
		apply(addListener, signal, ["abort", () => rej(signal.reason), { once: true }]);
		p.then(
			(r) => {
				if (signal.aborted) {
					try {
						r.body && r.body.cancel && r.body.cancel();
					} catch {}
				}
				res(r);
			},
			rej
		);
	});
}

async function serveFetch(url, req, destination) {
	const method = req.method;
	let body = null;
	if (method !== "GET" && method !== "HEAD") body = await req.arrayBuffer();
	const headers = [];
	for (const pair of req.headers) headers.push(pair);
	let r;
	try {
		r = await abortable(
			local(
				B.serve({
					url,
					method,
					headers,
					body,
					destination,
					mode: req.mode,
					credentials: req.credentials,
					redirect: req.redirect,
					referrer: clientUrl(),
					clientUrl: clientUrl(),
				})
			),
			apply(requestSignal, req, [])
		);
	} catch (e) {
		throw failedFetch(e);
	}
	return makeResponse(r, method);
}

function fetch(input, init) {
	let req;
	try {
		req = new _Request(input, init);
	} catch (e) {
		return _Promise.reject(e);
	}
	const url = apply(requestUrl, req, []);
	if (!isVirtual(url)) return apply(nativeFetch, win, [input, init]);
	return serveFetch(url, req, "");
}
defineProperty(win, "fetch", { value: fetch, writable: true, configurable: true, enumerable: true });

// ----------------------------------------------------------------------------
// network: XMLHttpRequest
// ----------------------------------------------------------------------------

const NativeXHR = win.XMLHttpRequest;
const XHR_EVENTS = ["loadstart", "progress", "abort", "error", "load", "timeout", "loadend"];

function defineHandlerProps(proto, names) {
	for (const name of names) {
		defineProperty(proto, "on" + name, {
			configurable: true,
			enumerable: true,
			get() {
				return (this.__sjlh && this.__sjlh[name]) || null;
			},
			set(fn) {
				if (!this.__sjlh) defineProperty(this, "__sjlh", { value: {}, enumerable: false });
				const had = name in this.__sjlh;
				this.__sjlh[name] = typeof fn === "function" || (fn && typeof fn === "object") ? fn : null;
				if (!had) {
					apply(addListener, this, [
						name,
						(e) => {
							const h = this.__sjlh[name];
							if (typeof h === "function") apply(h, this, [e]);
							else if (h && typeof h.handleEvent === "function") h.handleEvent(e);
						},
					]);
				}
			},
		});
	}
}

class XMLHttpRequestUpload extends _EventTarget {}
defineHandlerProps(XMLHttpRequestUpload.prototype, XHR_EVENTS);

function fire(target, type, init) {
	const e =
		type === "readystatechange" ? new _Event(type) : new _ProgressEvent(type, init || {});
	apply(dispatch, target, [e]);
}

function parseMime(ct) {
	if (!ct) return { essence: "", charset: null };
	const [essence, ...params] = ct.split(";");
	let charset = null;
	for (const p of params) {
		const m = /^\s*charset\s*=\s*"?([^";\s]+)"?/i.exec(p);
		if (m) charset = m[1];
	}
	return { essence: essence.trim().toLowerCase(), charset };
}

class XMLHttpRequest extends _EventTarget {
	#s;
	#upload = new XMLHttpRequestUpload();
	#native = null;

	constructor() {
		super();
		this.#reset();
		this.#s.responseType = "";
		this.#s.timeout = 0;
		this.#s.withCredentials = false;
	}

	#reset() {
		const keep = this.#s || {};
		this.#s = {
			rs: 0,
			method: "GET",
			url: "",
			async: true,
			headers: new _Map(),
			sent: false,
			aborted: false,
			status: 0,
			statusText: "",
			respHeaders: [],
			responseURL: "",
			chunks: [],
			loaded: 0,
			bytes: null,
			text: null,
			decoder: null,
			partialText: "",
			cached: undefined,
			mime: keep.mime ?? null,
			responseType: keep.responseType ?? "",
			timeout: keep.timeout ?? 0,
			withCredentials: keep.withCredentials ?? false,
			timer: null,
			gen: (keep.gen || 0) + 1,
		};
	}

	#setState(rs) {
		this.#s.rs = rs;
		fire(this, "readystatechange");
	}

	get readyState() {
		return this.#native ? this.#native.readyState : this.#s.rs;
	}
	get status() {
		return this.#native ? this.#native.status : this.#s.status;
	}
	get statusText() {
		return this.#native ? this.#native.statusText : this.#s.statusText;
	}
	get responseURL() {
		return this.#native ? this.#native.responseURL : this.#s.responseURL;
	}
	get upload() {
		return this.#upload;
	}
	get timeout() {
		return this.#s.timeout;
	}
	set timeout(v) {
		this.#s.timeout = Number(v) || 0;
		if (this.#native) this.#native.timeout = this.#s.timeout;
	}
	get withCredentials() {
		return this.#s.withCredentials;
	}
	set withCredentials(v) {
		this.#s.withCredentials = !!v;
		if (this.#native) this.#native.withCredentials = !!v;
	}
	get responseType() {
		return this.#s.responseType;
	}
	set responseType(v) {
		if (this.#s.rs === 3 || this.#s.rs === 4)
			throw new _DOMException("The response type cannot be set if the object's state is LOADING or DONE.", "InvalidStateError");
		const t = _String(v);
		if (!["", "text", "json", "arraybuffer", "blob", "document"].includes(t)) return;
		this.#s.responseType = t;
		if (this.#native) this.#native.responseType = t;
	}

	open(method, url, async, user, password) {
		if (this.#native) {
			try {
				this.#native.abort();
			} catch {}
			this.#native = null;
		}
		if (this.#s.rs !== 0 && this.#s.sent) this.#s.aborted = true;
		this.#reset();
		const m = _String(method);
		this.#s.method = /^(get|post|put|delete|head|options|patch)$/i.test(m) ? m.toUpperCase() : m;
		const abs = new _URL(_String(url), clientUrl()).href;
		this.#s.url = abs;
		this.#s.async = async === undefined ? true : !!async;
		if (!isVirtual(abs)) {
			// blob:, data: and friends: a real XHR handles those fine
			this.#native = this.#wrapNative();
			this.#native.open(method, abs, this.#s.async, user, password);
			return;
		}
		this.#setState(1);
	}

	#wrapNative() {
		const x = new NativeXHR();
		x.responseType = this.#s.responseType;
		x.timeout = this.#s.timeout;
		x.withCredentials = this.#s.withCredentials;
		if (this.#s.mime) x.overrideMimeType(this.#s.mime);
		const forward = (from, to) => (type) =>
			apply(addListener, from, [
				type,
				(e) => fire(to, type, { lengthComputable: e.lengthComputable, loaded: e.loaded, total: e.total }),
			]);
		["readystatechange", ...XHR_EVENTS].forEach(forward(x, this));
		XHR_EVENTS.forEach(forward(x.upload, this.#upload));
		return x;
	}

	setRequestHeader(name, value) {
		if (this.#native) return this.#native.setRequestHeader(name, value);
		if (this.#s.rs !== 1 || this.#s.sent)
			throw new _DOMException("The object's state must be OPENED.", "InvalidStateError");
		const key = _String(name).toLowerCase();
		const prev = this.#s.headers.get(key);
		this.#s.headers.set(key, [_String(name), prev ? prev[1] + ", " + _String(value) : _String(value)]);
	}

	overrideMimeType(m) {
		this.#s.mime = _String(m);
		if (this.#native) this.#native.overrideMimeType(m);
	}

	abort() {
		if (this.#native) return this.#native.abort();
		const s = this.#s;
		const inflight = (s.rs === 1 && s.sent) || s.rs === 2 || s.rs === 3;
		s.aborted = true;
		_clearTimeout(s.timer);
		if (inflight) {
			s.rs = 4;
			s.sent = false;
			s.status = 0;
			fire(this, "readystatechange");
			if (s.hadUpload) {
				fire(this.#upload, "abort");
				fire(this.#upload, "loadend");
			}
			fire(this, "abort");
			fire(this, "loadend");
		}
		if (s.rs === 4) s.rs = 0;
	}

	send(body) {
		if (this.#native) {
			this.#native.timeout = this.#s.timeout;
			this.#native.withCredentials = this.#s.withCredentials;
			this.#native.responseType = this.#s.responseType;
			return this.#native.send(body);
		}
		const s = this.#s;
		if (s.rs !== 1 || s.sent)
			throw new _DOMException("The object's state must be OPENED.", "InvalidStateError");
		if (!s.async) {
			// a synchronous request can't wait on an async transport from the main thread
			console.warn("[sjl] synchronous XMLHttpRequest isn't supported without a service worker:", B.unrewrite(s.url));
			throw new _DOMException("Failed to execute 'send' on 'XMLHttpRequest': synchronous requests are not supported by this proxy.", "NetworkError");
		}
		s.sent = true;
		const gen = s.gen;
		this.#run(body, gen);
	}

	async #run(body, gen) {
		const s = this.#s;
		const live = () => this.#s.gen === gen && !this.#s.aborted;
		let bytes = null;
		if (body != null && s.method !== "GET" && s.method !== "HEAD") {
			let init = body;
			if (IS_WINDOW && body instanceof win.Document) init = new win.XMLSerializer().serializeToString(body);
			const tmp = new _Request("https://x.invalid/", { method: "POST", body: init });
			bytes = await tmp.arrayBuffer();
			const ct = tmp.headers.get("content-type");
			if (ct && !s.headers.has("content-type")) s.headers.set("content-type", ["Content-Type", ct]);
		}
		if (!live()) return;
		fire(this, "loadstart", { loaded: 0, total: 0 });
		if (bytes) {
			s.hadUpload = true;
			const total = bytes.byteLength;
			fire(this.#upload, "loadstart", { lengthComputable: true, loaded: 0, total });
			fire(this.#upload, "progress", { lengthComputable: true, loaded: total, total });
			fire(this.#upload, "load", { lengthComputable: true, loaded: total, total });
			fire(this.#upload, "loadend", { lengthComputable: true, loaded: total, total });
		}
		if (s.timeout > 0) {
			s.timer = _setTimeout(() => {
				if (!live()) return;
				s.aborted = true;
				s.rs = 4;
				s.status = 0;
				fire(this, "readystatechange");
				fire(this, "timeout");
				fire(this, "loadend");
			}, s.timeout);
		}

		let r;
		try {
			r = await local(
				B.serve({
					url: s.url,
					method: s.method,
					headers: [...s.headers.values()],
					body: bytes,
					destination: "",
					mode: "cors",
					credentials: s.withCredentials ? "include" : "same-origin",
					referrer: clientUrl(),
					clientUrl: clientUrl(),
				})
			);
		} catch (e) {
			if (!live()) return;
			return this.#fail();
		}
		if (!live()) {
			try {
				r.body && r.body.cancel && r.body.cancel();
			} catch {}
			return;
		}

		s.status = r.status;
		s.statusText = r.statusText || "";
		s.responseURL = r.url;
		s.respHeaders = r.headers.filter(([k]) => !/^set-cookie2?$/i.test(k));
		this.#setState(2);

		const lenHeader = this.getResponseHeader("content-length");
		const total = lenHeader && /^\d+$/.test(lenHeader) ? +lenHeader : 0;
		const progress = () => ({ lengthComputable: total > 0, loaded: s.loaded, total });
		try {
			let src = r.body;
			if (src != null && typeof src.getReader !== "function") src = new _Response(src).body;
			if (src && s.method !== "HEAD" && !NULL_BODY.includes(s.status)) {
				const reader = src.getReader();
				let lastFire = 0;
				for (;;) {
					const { done, value } = await reader.read();
					if (!live()) {
						try {
							reader.cancel();
						} catch {}
						return;
					}
					if (done) break;
					const chunk = value instanceof _Uint8Array ? value : new _Uint8Array(value);
					s.chunks.push(chunk);
					s.loaded += chunk.byteLength;
					s.cached = undefined;
					if (s.rs !== 3) this.#setState(3);
					const now = Date.now();
					if (now - lastFire > 50) {
						lastFire = now;
						fire(this, "readystatechange");
						fire(this, "progress", progress());
					}
				}
			}
		} catch {
			if (!live()) return;
			return this.#fail();
		}
		_clearTimeout(s.timer);
		s.bytes = this.#concat();
		s.cached = undefined;
		if (s.rs !== 3) this.#setState(3);
		this.#setState(4);
		fire(this, "progress", progress());
		fire(this, "load", progress());
		fire(this, "loadend", progress());
	}

	#fail() {
		const s = this.#s;
		_clearTimeout(s.timer);
		s.status = 0;
		s.respHeaders = [];
		s.rs = 4;
		fire(this, "readystatechange");
		if (s.hadUpload) {
			fire(this.#upload, "error");
			fire(this.#upload, "loadend");
		}
		fire(this, "error");
		fire(this, "loadend");
	}

	#concat() {
		const s = this.#s;
		if (s.chunks.length === 1) return s.chunks[0];
		const out = new _Uint8Array(s.loaded);
		let off = 0;
		for (const c of s.chunks) {
			out.set(c, off);
			off += c.byteLength;
		}
		s.chunks = [out];
		return out;
	}

	#mime() {
		return parseMime(this.#s.mime || this.getResponseHeader("content-type") || "");
	}

	#decode() {
		const s = this.#s;
		if (s.text !== null && s.rs === 4) return s.text;
		const bytes = s.rs === 4 ? s.bytes : this.#concat();
		if (!bytes) return "";
		let charset = this.#mime().charset || "utf-8";
		let text;
		try {
			text = new _TextDecoder(charset).decode(bytes);
		} catch {
			text = new _TextDecoder().decode(bytes);
		}
		if (s.rs === 4) s.text = text;
		return text;
	}

	get responseText() {
		if (this.#native) return this.#native.responseText;
		const t = this.#s.responseType;
		if (t !== "" && t !== "text")
			throw new _DOMException("The value is only accessible if the object's 'responseType' is '' or 'text'.", "InvalidStateError");
		if (this.#s.rs < 3) return "";
		return this.#decode();
	}

	get responseXML() {
		if (this.#native) return this.#native.responseXML;
		const t = this.#s.responseType;
		if (t !== "" && t !== "document")
			throw new _DOMException("The value is only accessible if the object's 'responseType' is '' or 'document'.", "InvalidStateError");
		if (this.#s.rs !== 4 || !IS_WINDOW) return null;
		return this.#parseDocument(t === "document");
	}

	#parseDocument(anyType) {
		const { essence } = this.#mime();
		const isHtml = essence === "text/html";
		const isXml = /[/+]xml$/.test(essence) || essence === "";
		if (!isHtml && !isXml) return null;
		if (isHtml && !anyType) return null;
		try {
			return new win.DOMParser().parseFromString(this.#decode(), isHtml ? "text/html" : "application/xml");
		} catch {
			return null;
		}
	}

	get response() {
		if (this.#native) return this.#native.response;
		const s = this.#s;
		const t = s.responseType;
		if (t === "" || t === "text") return s.rs < 3 ? "" : this.#decode();
		if (s.rs !== 4) return null;
		if (s.cached !== undefined) return s.cached;
		let v = null;
		const bytes = s.bytes || new _Uint8Array(0);
		if (t === "arraybuffer") {
			v = bytes.byteOffset === 0 && bytes.byteLength === bytes.buffer.byteLength ? bytes.buffer : bytes.slice().buffer;
		} else if (t === "blob") {
			v = new _Blob([bytes], { type: this.#mime().essence });
		} else if (t === "json") {
			try {
				v = _JSON.parse(this.#decode());
			} catch {
				v = null;
			}
		} else if (t === "document") {
			v = IS_WINDOW ? this.#parseDocument(true) : null;
		}
		s.cached = v;
		return v;
	}

	getResponseHeader(name) {
		if (this.#native) return this.#native.getResponseHeader(name);
		if (this.#s.rs < 2) return null;
		const key = _String(name).toLowerCase();
		const vals = this.#s.respHeaders.filter(([k]) => k.toLowerCase() === key).map(([, v]) => v);
		return vals.length ? vals.join(", ") : null;
	}

	getAllResponseHeaders() {
		if (this.#native) return this.#native.getAllResponseHeaders();
		if (this.#s.rs < 2) return "";
		const merged = new _Map();
		for (const [k, v] of this.#s.respHeaders) {
			const key = k.toLowerCase();
			merged.set(key, merged.has(key) ? merged.get(key) + ", " + v : v);
		}
		return [...merged.keys()]
			.sort()
			.map((k) => k + ": " + merged.get(k) + "\r\n")
			.join("");
	}
}
defineHandlerProps(XMLHttpRequest.prototype, ["readystatechange", ...XHR_EVENTS]);
for (const [i, k] of ["UNSENT", "OPENED", "HEADERS_RECEIVED", "LOADING", "DONE"].entries()) {
	defineProperty(XMLHttpRequest, k, { value: i, enumerable: true });
	defineProperty(XMLHttpRequest.prototype, k, { value: i, enumerable: true });
}
defineProperty(win, "XMLHttpRequest", { value: XMLHttpRequest, writable: true, configurable: true });

// ----------------------------------------------------------------------------
// network: EventSource
// ----------------------------------------------------------------------------

const NativeEventSource = win.EventSource;
if (NativeEventSource) {
	class EventSource extends _EventTarget {
		#url;
		#state = 0;
		#withCredentials;
		#closed = false;
		#reader = null;
		#lastId = "";
		#retry = 3000;

		constructor(url, init) {
			const abs = new _URL(_String(url), clientUrl()).href;
			if (!isVirtual(abs)) return new NativeEventSource(url, init);
			super();
			this.#url = abs;
			this.#withCredentials = !!(init && init.withCredentials);
			this.#connect();
		}
		get url() {
			return this.#url;
		}
		get readyState() {
			return this.#state;
		}
		get withCredentials() {
			return this.#withCredentials;
		}
		close() {
			this.#closed = true;
			this.#state = 2;
			try {
				this.#reader && this.#reader.cancel();
			} catch {}
		}
		async #connect() {
			const headers = [
				["Accept", "text/event-stream"],
				["Cache-Control", "no-cache"],
			];
			if (this.#lastId) headers.push(["Last-Event-ID", this.#lastId]);
			let r;
			try {
				r = await local(B.serve({ url: this.#url, headers, destination: "", mode: "cors", referrer: clientUrl(), clientUrl: clientUrl() }));
			} catch {
				return this.#reconnect();
			}
			if (this.#closed) return;
			const ct = (r.headers.find(([k]) => k.toLowerCase() === "content-type") || [])[1] || "";
			if (r.status !== 200 || !/^text\/event-stream/i.test(ct)) {
				discard(r.body);
				this.#state = 2;
				return apply(dispatch, this, [new _Event("error")]);
			}
			this.#state = 1;
			apply(dispatch, this, [new _Event("open")]);
			let origin = "";
			try {
				origin = new _URL(B.unrewrite(this.#url)).origin;
			} catch {}
			const body = typeof r.body?.getReader === "function" ? r.body : new _Response(r.body).body;
			this.#reader = body.getReader();
			const dec = new _TextDecoder();
			let buf = "";
			let data = "";
			let type = "";
			try {
				for (;;) {
					const { done, value } = await this.#reader.read();
					if (done) break;
					buf += dec.decode(value, { stream: true });
					let idx;
					while ((idx = buf.search(/\r\n|\r|\n/)) !== -1) {
						const line = buf.slice(0, idx);
						buf = buf.slice(idx + (buf[idx] === "\r" && buf[idx + 1] === "\n" ? 2 : 1));
						if (line === "") {
							if (data) {
								const ev = new _MessageEvent(type || "message", {
									data: data.endsWith("\n") ? data.slice(0, -1) : data,
									lastEventId: this.#lastId,
									origin,
								});
								apply(dispatch, this, [ev]);
							}
							data = "";
							type = "";
							continue;
						}
						if (line[0] === ":") continue;
						const colon = line.indexOf(":");
						const field = colon === -1 ? line : line.slice(0, colon);
						let value = colon === -1 ? "" : line.slice(colon + 1);
						if (value[0] === " ") value = value.slice(1);
						if (field === "data") data += value + "\n";
						else if (field === "event") type = value;
						else if (field === "id" && !value.includes("\0")) this.#lastId = value;
						else if (field === "retry" && /^\d+$/.test(value)) this.#retry = +value;
					}
				}
			} catch {}
			this.#reconnect();
		}
		#reconnect() {
			if (this.#closed) return;
			this.#state = 0;
			apply(dispatch, this, [new _Event("error")]);
			_setTimeout(() => !this.#closed && this.#connect(), this.#retry);
		}
	}
	defineHandlerProps(EventSource.prototype, ["open", "message", "error"]);
	for (const [i, k] of ["CONNECTING", "OPEN", "CLOSED"].entries()) {
		defineProperty(EventSource, k, { value: i, enumerable: true });
		defineProperty(EventSource.prototype, k, { value: i, enumerable: true });
	}
	defineProperty(win, "EventSource", { value: EventSource, writable: true, configurable: true });
}

// ----------------------------------------------------------------------------
// network: sendBeacon
// ----------------------------------------------------------------------------

if (win.Navigator && win.Navigator.prototype.sendBeacon) {
	const nativeBeacon = win.Navigator.prototype.sendBeacon;
	win.Navigator.prototype.sendBeacon = function sendBeacon(url, data) {
		const abs = new _URL(_String(url), clientUrl()).href;
		if (!isVirtual(abs)) return apply(nativeBeacon, this, arguments);
		(async () => {
			const req = new _Request(abs, { method: "POST", body: data ?? null });
			await serveFetch(abs, req, "").catch(() => {});
		})();
		return true;
	};
}

// ----------------------------------------------------------------------------
// dynamic import(): scramjet builds its import trampoline from natives.Function
// ----------------------------------------------------------------------------

const nativeImport = new _Function("u", "return import(u)");
function realmImport(url) {
	url = _String(url);
	if (!isVirtual(url) && B.resolveBare && !/^[./]|:/.test(url)) {
		// bare specifier: the import map entries for it were resolved by us
		const v = B.resolveBare(url);
		if (v) url = v;
	}
	if (!isVirtual(url)) return nativeImport(url);
	return new _Promise((res, rej) => {
		B.resolve(url, "module", clientUrl()).then(
			(blob) => {
				if (!blob) return rej(new _TypeError("Failed to fetch dynamically imported module: " + B.unrewrite(url)));
				nativeImport(blob).then(res, rej);
			},
			(e) => rej(new _TypeError("Failed to fetch dynamically imported module: " + B.unrewrite(url)))
		);
	});
}
function functionForScramjet(...args) {
	if (args.length === 2 && args[0] === "url" && args[1] === "return import(url)") return realmImport;
	return apply(_Function, null, args);
}

// ----------------------------------------------------------------------------
// workers: bootstrap a proxied realm inside the worker
// ----------------------------------------------------------------------------

function installWorkers() {
	const NativeWorker = win.Worker;
	if (!NativeWorker) return;
	const postMessage = NativeWorker.prototype.postMessage;

	const spawn = (url, opts, shared) => {
		const isModule = !!(opts && opts.type === "module");
		const boot = B.workerBoot();
		// always classic: a module worker can't start from a blob: url at an opaque origin.
		// the boot script runs a module worker's code through import()
		const w = new NativeWorker(boot.bootUrl, {
			type: "classic",
			name: opts && opts.name ? _String(opts.name) : "",
			credentials: opts && opts.credentials,
		});
		const ch = new _MessageChannel();
		B.workerRpc(ch.port1, clientUrl());
		apply(postMessage, w, [
			{
				__sjlboot: {
					...boot,
					sinkSource: B.sinkSource,
					url,
					isModule,
					shared,
					port: ch.port2,
				},
			},
			[ch.port2],
		]);
		return w;
	};

	function Worker(url, opts) {
		if (!new.target) throw new _TypeError("Failed to construct 'Worker': Please use the 'new' operator.");
		const abs = new _URL(_String(url), clientUrl()).href;
		if (!isVirtual(abs)) return new NativeWorker(url, opts);
		return spawn(abs, opts, false);
	}
	Worker.prototype = NativeWorker.prototype;
	defineProperty(win, "Worker", { value: Worker, writable: true, configurable: true });

	const NativeShared = win.SharedWorker;
	if (NativeShared) {
		// shared workers can't be bootstrapped the same way; give each page its own
		// dedicated worker that receives a "connect" event like a shared one would
		function SharedWorker(url, opts) {
			if (!new.target) throw new _TypeError("Failed to construct 'SharedWorker': Please use the 'new' operator.");
			const abs = new _URL(_String(url), clientUrl()).href;
			if (!isVirtual(abs)) return new NativeShared(url, opts);
			const o = typeof opts === "string" ? { name: opts } : opts || {};
			const w = spawn(abs, o, true);
			const ch = new _MessageChannel();
			apply(postMessage, w, [{ __sjlconnect: true }, [ch.port2]]);
			const fake = new _EventTarget();
			defineProperty(fake, "port", { value: ch.port1, enumerable: true });
			apply(addListener, w, ["error", (e) => apply(dispatch, fake, [new _Event("error")])]);
			return fake;
		}
		SharedWorker.prototype = _Object.create(_EventTarget.prototype);
		defineHandlerProps(SharedWorker.prototype, ["error"]);
		defineProperty(win, "SharedWorker", { value: SharedWorker, writable: true, configurable: true });
	}
}
if (IS_WINDOW) installWorkers();

// importScripts is synchronous; without a service worker we can only serve scripts that
// were resolved before the worker's code started (literal importScripts() arguments)
if (!IS_WINDOW && typeof win.importScripts === "function") {
	const nativeImportScripts = win.importScripts;
	win.importScripts = function importScripts(...urls) {
		const out = urls.map((u) => {
			u = _String(u);
			if (!isVirtual(u)) return u;
			const rest = u.slice(PREFIX.length);
			if (rest.startsWith("data:")) return rest;
			if (rest.startsWith("blob:")) return "blob:" + BLOB_ORIGIN + new _URL(rest.slice(5)).pathname;
			const real = B.unrewrite(u);
			const blob = B.importScriptsMap && B.importScriptsMap[real];
			if (!blob) {
				throw new _DOMException(
					"Failed to execute 'importScripts' on 'WorkerGlobalScope': " + real + " could not be loaded synchronously without a service worker.",
					"NetworkError"
				);
			}
			return blob;
		});
		return apply(nativeImportScripts, win, out);
	};
}

// ============================================================================
// everything below is DOM-only
// ============================================================================

let api = {
	functionForScramjet,
	afterHook() {
		unshadowServiceWorker();
	},
	documentReset() {},
	addImportMap() {},
};

if (IS_WINDOW) api = installDom();
return api;

function installDom() {
	// Chrome (seen on 154) aborts the whole tab (SIGTRAP, "Error code: 5") while
	// snapshotting the old state of some same-document view transitions when the page lives
	// in one of our frames. YouTube hits it on every click into a video; top-level YouTube in
	// the same browser is fine. Sites feature-detect this API (many browsers lack it), so
	// hiding it just skips the animation.
	for (const proto of [win.Document.prototype, win.Element.prototype]) {
		if (proto && "startViewTransition" in proto) {
			try {
				delete proto.startViewTransition;
			} catch {}
		}
	}

	const SVG_NS = "http://www.w3.org/2000/svg";
	const EP = win.Element.prototype;
	const n = {
		setAttribute: EP.setAttribute,
		setAttributeNS: EP.setAttributeNS,
		getAttribute: EP.getAttribute,
		removeAttribute: EP.removeAttribute,
		hasAttribute: EP.hasAttribute,
		qsa: EP.querySelectorAll,
		docQsa: win.Document.prototype.querySelectorAll,
		fragQsa: win.DocumentFragment.prototype.querySelectorAll,
		closest: EP.closest,
		createElement: win.Document.prototype.createElement,
		append: EP.append,
		prepend: EP.prepend,
		attachShadow: EP.attachShadow,
		isConnected: getDesc(win.Node.prototype, "isConnected").get,
		parentNode: getDesc(win.Node.prototype, "parentNode").get,
		textContent: getDesc(win.Node.prototype, "textContent"),
		innerHTML: getDesc(EP, "innerHTML"),
		outerHTML: getDesc(EP, "outerHTML"),
		insertAdjacentHTML: EP.insertAdjacentHTML,
		setHTMLUnsafe: EP.setHTMLUnsafe,
		write: win.Document.prototype.write,
		writeln: win.Document.prototype.writeln,
		pushState: win.History.prototype.pushState,
		replaceState: win.History.prototype.replaceState,
		title: getDesc(win.Document.prototype, "title").get,
		head: getDesc(win.Document.prototype, "head").get,
		scriptAsync: getDesc(win.HTMLScriptElement.prototype, "async").get,
		anchorHref: getDesc(win.HTMLAnchorElement.prototype, "href").get,
		formAction: getDesc(win.HTMLFormElement.prototype, "action").get,
		buttonFormAction: getDesc(win.HTMLButtonElement.prototype, "formAction").get,
		inputFormAction: getDesc(win.HTMLInputElement.prototype, "formAction").get,
		areaHref: getDesc(win.HTMLAreaElement.prototype, "href").get,
		MutationObserver: win.MutationObserver,
		IntersectionObserver: win.IntersectionObserver,
		open: win.open,
		frameName: getDesc(win.HTMLIFrameElement.prototype, "name").get,
	};
	const call = (fn, self, ...args) => apply(fn, self, args);
	// querySelectorAll lives on three prototypes; each only accepts its own kind of node
	const qsa = (root, sel) =>
		apply(root.nodeType === 1 ? n.qsa : root.nodeType === 9 ? n.docQsa : n.fragQsa, root, [sel]);
	const isConnected = (el) => call(n.isConnected, el);
	const getAttr = (el, name) => call(n.getAttribute, el, name);

	// what we last wrote into a native attribute, so the observer ignores our own writes
	const lastNative = new _WeakMap();
	function nativeSet(el, name, value) {
		let m = lastNative.get(el);
		if (!m) lastNative.set(el, (m = new _Map()));
		m.set(name, value);
		if (name === "xlink:href") call(n.setAttributeNS, el, "http://www.w3.org/1999/xlink", name, value);
		else call(n.setAttribute, el, name, value);
	}
	const isOwnWrite = (el, name, value) => {
		const m = lastNative.get(el);
		return !!m && m.get(name) === value;
	};

	// the virtual url the page set, per element+attribute (for getters), and a generation
	// counter so a slow resolve can't overwrite a newer value
	const virt = new _WeakMap();
	const gens = new _WeakMap();
	let genCounter = 0;
	const setVirt = (el, name, v) => {
		let m = virt.get(el);
		if (!m) virt.set(el, (m = new _Map()));
		m.set(name, v);
	};
	const getVirt = (el, name) => virt.get(el)?.get(name);
	const clearVirt = (el, name) => virt.get(el)?.delete(name);
	const bump = (el, name) => {
		let m = gens.get(el);
		if (!m) gens.set(el, (m = new _Map()));
		const g = ++genCounter;
		m.set(name, g);
		return g;
	};
	const current = (el, name, g) => gens.get(el)?.get(name) === g;

	function kindFor(el, name) {
		const tag = el.localName;
		if (el.namespaceURI === SVG_NS) {
			if ((name === "href" || name === "xlink:href") && tag !== "a") return "image";
			if (name === "style") return "style";
			return null;
		}
		switch (name) {
			case "src":
				switch (tag) {
					case "script":
						return "script";
					case "iframe":
					case "frame":
						return "frame";
					case "img":
					case "input":
						return "image";
					case "source":
						return call(n.parentNode, el)?.localName === "picture" ? "image" : "media";
					case "video":
					case "audio":
						return "media";
					case "track":
						return "track";
					case "embed":
						return "object";
				}
				return null;
			case "srcset":
				return tag === "img" || tag === "source" ? "srcset" : null;
			case "imagesrcset":
				return tag === "link" ? "srcset" : null;
			case "poster":
				return tag === "video" ? "image" : null;
			case "data":
				return tag === "object" ? "object" : null;
			case "href":
				return tag === "link" ? "link" : null;
			case "style":
				return "style";
			case "srcdoc":
				return tag === "iframe" ? "srcdoc" : null;
		}
		return null;
	}

	// scripts/links/iframes only do anything once they're in the document. a WeakSet, so the
	// ones a page creates and never inserts don't pile up; we look for them among inserted
	// nodes instead of rechecking every pending element on each mutation
	const pending = new _WeakSet();
	let pendingCount = 0;
	const PENDING_TAGS = "script,link,iframe,frame";
	const scriptQueue = [];

	/** Returns true if we took over setting this attribute. */
	function applyAttr(el, name, value) {
		const kind = kindFor(el, name);
		if (!kind) return false;
		if (kind === "style") {
			if (!hasVirtual(value)) return false;
			const g = bump(el, "style");
			nativeSet(el, "style", B.cachedCss(value));
			B.resolveCss(value, clientUrl()).then((css) => current(el, "style", g) && nativeSet(el, "style", css), () => {});
			return true;
		}
		if (kind === "srcset") {
			if (!hasVirtual(value)) return false;
			const g = bump(el, name);
			setVirt(el, name, value);
			const parts = value.split(",").map((p) => p.trim()).filter(Boolean);
			local(
				_Promise.all(
					parts.map(async (p) => {
						const [url, ...desc] = p.split(/\s+/);
						const blob = isVirtual(url) ? await local(B.resolve(url, "image", clientUrl())) : url;
						return [blob || INVALID, ...desc].join(" ");
					})
				)
			).then((out) => current(el, name, g) && nativeSet(el, name, out.join(", ")));
			return true;
		}
		if (kind === "srcdoc") {
			if (!hasVirtual(value)) return false;
			const g = bump(el, "srcdoc");
			B.prepareSrcdoc(value, clientUrl()).then((html) => current(el, "srcdoc", g) && nativeSet(el, "srcdoc", html), () => {});
			return true;
		}
		if (!isVirtual(value)) {
			clearVirt(el, name);
			bump(el, name);
			return false;
		}
		const g = bump(el, name);
		setVirt(el, name, value);
		if (kind === "image" || kind === "media" || kind === "track") {
			const direct = directUrl(value);
			if (direct) {
				nativeSet(el, name, direct);
				return true;
			}
		}
		if (kind === "script" || kind === "link" || kind === "frame") {
			if (!pending.has(el)) (pending.add(el), pendingCount++);
			if (isConnected(el)) activatePending(el);
			return true;
		}
		loadAsset(el, name, value, kind, g);
		return true;
	}

	// images/media pointing at data: or blob: urls need no rewriting; skip the round trip
	function directUrl(v) {
		const rest = v.slice(PREFIX.length);
		if (rest.startsWith("data:")) return rest;
		if (rest.startsWith("blob:")) {
			try {
				return "blob:" + BLOB_ORIGIN + new _URL(rest.slice(5)).pathname;
			} catch {
				return null;
			}
		}
		return null;
	}

	const lazyObserver =
		n.IntersectionObserver &&
		new n.IntersectionObserver(
			(entries) => {
				for (const e of entries) {
					if (!e.isIntersecting) continue;
					lazyObserver.unobserve(e.target);
					const job = lazyJobs.get(e.target);
					lazyJobs.delete(e.target);
					job && job();
				}
			},
			{ rootMargin: "1200px" }
		);
	const lazyJobs = new _WeakMap();

	function loadAsset(el, name, value, kind, g) {
		const run = () => {
			const hashless = !value.includes("#");
			const hit = hashless ? B.peek(value, kind) : undefined;
			if (hit !== undefined) return nativeSet(el, name, hit || INVALID);
			B.resolve(value, kind, clientUrl()).then(
				(u) => current(el, name, g) && nativeSet(el, name, u || INVALID),
				() => current(el, name, g) && nativeSet(el, name, INVALID)
			);
		};
		if (lazyObserver && el.localName === "img" && getAttr(el, "loading") === "lazy" && isConnected(el)) {
			lazyJobs.set(el, run);
			lazyObserver.observe(el);
			return;
		}
		run();
	}

	function scriptType(el) {
		if (call(n.hasAttribute, el, "nomodule")) return null;
		const t = (getAttr(el, "type") || "").trim().toLowerCase();
		if (t === "module") return "module";
		if (t === "" || /^(text|application)\/(x-)?(java|ecma)script$|^text\/(jscript|livescript)$/.test(t)) return "script";
		return null;
	}

	function activatePending(el) {
		if (!pending.delete(el)) return;
		pendingCount--;
		activate(el);
	}
	/** pending elements inside a subtree that just got inserted */
	function activatePendingIn(node) {
		if (pendingCount <= 0 || !(node.nodeType === 1 || node.nodeType === 9 || node.nodeType === 11)) return;
		if (node.nodeType === 1 && pending.has(node)) activatePending(node);
		if (node.firstElementChild)
			for (const el of qsa(node, PENDING_TAGS)) if (pending.has(el) && isConnected(el)) activatePending(el);
	}

	function activate(el) {
		const tag = el.localName;
		if (tag === "script") return activateScript(el);
		if (tag === "link") return activateLink(el);
		if (tag === "iframe" || tag === "frame") {
			const v = getVirt(el, "src");
			if (v) B.loadFrame(el, v, clientUrl());
		}
	}

	function activateScript(el) {
		const v = getVirt(el, "src");
		if (!v) return;
		const kind = scriptType(el);
		if (!kind) return nativeSet(el, "src", v);
		const p = local(B.resolve(v, kind, clientUrl())).catch(() => null);
		// async=false dynamic scripts must run in insertion order
		if (call(n.scriptAsync, el) === false) {
			const entry = { el, url: undefined };
			scriptQueue.push(entry);
			p.then((u) => {
				entry.url = u || INVALID;
				while (scriptQueue.length && scriptQueue[0].url !== undefined) {
					const e = scriptQueue.shift();
					nativeSet(e.el, "src", e.url);
				}
			});
		} else {
			p.then((u) => nativeSet(el, "src", u || INVALID));
		}
	}

	function activateLink(el) {
		const v = getVirt(el, "href");
		if (!v) return;
		const g = bump(el, "href");
		const rel = (getAttr(el, "rel") || "").toLowerCase().split(/\s+/);
		const as = (getAttr(el, "as") || "").toLowerCase();
		let kind = null;
		let icon = false;
		if (rel.includes("stylesheet")) kind = "style";
		else if (rel.includes("icon") || rel.includes("apple-touch-icon")) (kind = "image"), (icon = true);
		else if (rel.includes("modulepreload")) kind = "module";
		else if (rel.includes("preload") || rel.includes("prefetch"))
			kind = { style: "style", script: "script", font: "font", image: "image", fetch: "fetch" }[as] || "fetch";
		else if (rel.includes("manifest") || rel.includes("preconnect") || rel.includes("dns-prefetch")) return;
		if (!kind) return nativeSet(el, "href", v);
		B.resolve(v, kind, clientUrl()).then(
			(u) => {
				if (!current(el, "href", g)) return;
				nativeSet(el, "href", u || INVALID);
				if (icon && u) B.iconChanged(u);
			},
			() => current(el, "href", g) && nativeSet(el, "href", INVALID)
		);
	}

	// ---- attribute setters: the sink under scramjet's setAttribute hook ----
	EP.setAttribute = function setAttribute(name, value) {
		const lname = _String(name).toLowerCase();
		if ((lname === "src" || lname === "href") && call(n.hasAttribute, this, "scramjet-attr-sjlv-" + lname))
			call(n.removeAttribute, this, "scramjet-attr-sjlv-" + lname);
		if (!lname.startsWith("scramjet-attr") && typeof value === "string") {
			if (applyAttr(this, lname, value)) return;
		} else if (!lname.startsWith("scramjet-attr")) {
			clearVirt(this, lname);
		}
		return apply(n.setAttribute, this, arguments);
	};
	EP.setAttributeNS = function setAttributeNS(ns, name, value) {
		const lname = _String(name).toLowerCase();
		if (typeof value === "string" && (lname === "href" || lname === "xlink:href") && applyAttr(this, lname, value)) return;
		return apply(n.setAttributeNS, this, arguments);
	};
	EP.removeAttribute = function removeAttribute(name) {
		const lname = _String(name).toLowerCase();
		clearVirt(this, lname);
		bump(this, lname);
		if (pending.delete(this)) pendingCount--;
		return apply(n.removeAttribute, this, arguments);
	};

	// ---- property getters/setters for url attributes ----
	// scramjet wraps these getters and unrewrites what we return, so hand back the virtual url
	const WRAPPED = [
		[win.HTMLImageElement, "src", "src"],
		[win.HTMLMediaElement, "src", "src"],
		[win.HTMLIFrameElement, "src", "src"],
		[win.HTMLFrameElement, "src", "src"],
		[win.HTMLEmbedElement, "src", "src"],
		[win.HTMLScriptElement, "src", "src"],
		[win.HTMLSourceElement, "src", "src"],
		[win.HTMLLinkElement, "href", "href"],
		[win.HTMLObjectElement, "data", "data"],
		[win.HTMLVideoElement, "poster", "poster"],
	];
	for (const [ctor, prop, attr] of WRAPPED) {
		if (!ctor) continue;
		const d = getDesc(ctor.prototype, prop);
		if (!d || !d.get) continue;
		defineProperty(ctor.prototype, prop, {
			...d,
			get() {
				const v = getVirt(this, attr) ?? getAttr(this, "scramjet-attr-sjlv-" + attr);
				return v !== undefined && v !== null ? v : apply(d.get, this, []);
			},
		});
	}
	// scramjet doesn't wrap these; route sets through setAttribute so they get rewritten,
	// and answer gets with the page-visible value
	const UNWRAPPED = [
		[win.HTMLImageElement, "srcset", "srcset"],
		[win.HTMLSourceElement, "srcset", "srcset"],
		[win.HTMLInputElement, "src", "src"],
		[win.HTMLTrackElement, "src", "src"],
		[win.HTMLLinkElement, "imageSrcset", "imagesrcset"],
	];
	for (const [ctor, prop, attr] of UNWRAPPED) {
		if (!ctor) continue;
		const d = getDesc(ctor.prototype, prop);
		if (!d || !d.get) continue;
		const urlish = attr === "src";
		defineProperty(ctor.prototype, prop, {
			...d,
			get() {
				const v = getVirt(this, attr);
				if (v === undefined) return apply(d.get, this, []);
				return urlish ? B.unrewrite(v) : this.getAttribute(attr) ?? "";
			},
			set(v) {
				this.setAttribute(attr, v);
			},
		});
	}
	for (const ctor of [win.HTMLImageElement, win.HTMLMediaElement]) {
		const d = ctor && getDesc(ctor.prototype, "currentSrc");
		if (!d || !d.get) continue;
		defineProperty(ctor.prototype, "currentSrc", {
			...d,
			get() {
				const v = getVirt(this, "src");
				return v !== undefined ? B.unrewrite(v) : apply(d.get, this, []);
			},
		});
	}

	// ---- html string sinks: keep the parser from requesting virtual urls ----
	const PENDING = "scramjet-attr-sjlp-";
	const PENDING_ATTRS = ["src", "srcset", "poster", "data", "href", "xlink:href", "imagesrcset"];
	const escRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
	const markRe = new RegExp('(\\s)(src|srcset|poster|data|imagesrcset)="(?=' + escRe(PREFIX) + ")", "gi");
	const markPending = (html) => (typeof html === "string" && html.includes(PREFIX) ? html.replace(markRe, "$1" + PENDING + '$2="') : html);
	const escAttr = (a) => a.replace(":", "\\:");
	const PENDING_SEL = PENDING_ATTRS.map((a) => "[" + escAttr(PENDING + a) + "]").join(",");
	const VIRTUAL_SEL =
		["src", "href", "srcset", "poster", "data", "imagesrcset", "style"]
			.map((a) => `[${a}*="${PREFIX.replace(/"/g, '\\"')}"]`)
			.join(",") + ",style";
	const SCAN_SEL = PENDING_SEL + "," + VIRTUAL_SEL;

	function takePending(el) {
		for (const a of PENDING_ATTRS) {
			const v = getAttr(el, PENDING + a);
			if (v === null) continue;
			call(n.removeAttribute, el, PENDING + a);
			if (!applyAttr(el, a, v)) nativeSet(el, a, v);
		}
	}

	function resolveMarked(root) {
		if (!root || typeof root.querySelectorAll !== "function") return;
		for (const el of qsa(root, PENDING_SEL)) takePending(el);
	}

	function setStyleText(el, css, set) {
		const g = bump(el, "#text");
		set(B.cachedCss(css));
		B.resolveCss(css, clientUrl()).then((c) => current(el, "#text", g) && set(c), () => {});
	}
	function setModuleText(el, js, set) {
		const g = bump(el, "#text");
		// an empty connected script isn't "started" yet; filling it in later runs it
		set("");
		B.linkModule(js, clientUrl()).then((linked) => current(el, "#text", g) && set(linked), () => {});
	}
	function textSink(el, value, set) {
		if (!el || typeof value !== "string") return false;
		if (el.localName === "style" && hasVirtual(value)) {
			setStyleText(el, value, set);
			return true;
		}
		if (el.localName === "script" && scriptType(el) === "module" && B.hasModuleLiterals(value)) {
			setModuleText(el, value, set);
			return true;
		}
		return false;
	}

	defineProperty(win.Node.prototype, "textContent", {
		...n.textContent,
		set(v) {
			const set = (x) => apply(n.textContent.set, this, [x]);
			if (textSink(this, v, set)) return;
			set(v);
		},
	});
	defineProperty(EP, "innerHTML", {
		...n.innerHTML,
		set(v) {
			const set = (x) => apply(n.innerHTML.set, this, [x]);
			if (textSink(this, v, (x) => apply(n.textContent.set, this, [x]))) return;
			set(markPending(v));
			resolveMarked(this);
		},
	});
	defineProperty(EP, "outerHTML", {
		...n.outerHTML,
		set(v) {
			const parent = call(n.parentNode, this);
			apply(n.outerHTML.set, this, [markPending(v)]);
			resolveMarked(parent);
		},
	});
	EP.insertAdjacentHTML = function insertAdjacentHTML(pos, html) {
		const r = apply(n.insertAdjacentHTML, this, [pos, markPending(html)]);
		resolveMarked(call(n.parentNode, this) || this);
		return r;
	};
	if (n.setHTMLUnsafe) {
		EP.setHTMLUnsafe = function setHTMLUnsafe(html) {
			const r = apply(n.setHTMLUnsafe, this, [markPending(html)]);
			resolveMarked(this);
			return r;
		};
	}
	win.Document.prototype.write = function write(...parts) {
		return apply(n.write, this, parts.map((p) => markPending(_String(p))));
	};
	win.Document.prototype.writeln = function writeln(...parts) {
		return apply(n.writeln, this, parts.map((p) => markPending(_String(p))));
	};

	// ---- css sinks ----
	const cssProps = [
		"background",
		"backgroundImage",
		"borderImage",
		"borderImageSource",
		"listStyle",
		"listStyleImage",
		"mask",
		"maskImage",
		"webkitMask",
		"webkitMaskImage",
		"cursor",
		"content",
	];
	const cssProto = (win.CSS2Properties || win.CSSStyleDeclaration).prototype;
	for (const prop of cssProps) {
		for (const proto of [cssProto, win.CSSStyleDeclaration.prototype]) {
			const d = getDesc(proto, prop);
			if (!d || !d.set) continue;
			defineProperty(proto, prop, {
				...d,
				set(v) {
					if (!hasVirtual(v)) return apply(d.set, this, [v]);
					apply(d.set, this, [B.cachedCss(v)]);
					const self = this;
					B.resolveCss(v, clientUrl()).then((css) => apply(d.set, self, [css]), () => {});
				},
			});
		}
	}
	{
		const setProperty = win.CSSStyleDeclaration.prototype.setProperty;
		win.CSSStyleDeclaration.prototype.setProperty = function (name, value, prio) {
			if (!hasVirtual(value)) return apply(setProperty, this, arguments);
			apply(setProperty, this, [name, B.cachedCss(value), prio]);
			B.resolveCss(value, clientUrl()).then((css) => apply(setProperty, this, [name, css, prio]), () => {});
		};
		const cssText = getDesc(win.CSSStyleDeclaration.prototype, "cssText");
		defineProperty(win.CSSStyleDeclaration.prototype, "cssText", {
			...cssText,
			set(v) {
				if (!hasVirtual(v)) return apply(cssText.set, this, [v]);
				apply(cssText.set, this, [B.cachedCss(v)]);
				B.resolveCss(v, clientUrl()).then((css) => apply(cssText.set, this, [css]), () => {});
			},
		});
		const SP = win.CSSStyleSheet.prototype;
		const insertRule = SP.insertRule;
		SP.insertRule = function (rule, index) {
			if (!hasVirtual(rule)) return apply(insertRule, this, arguments);
			const i = apply(insertRule, this, [B.cachedCss(rule), index ?? 0]);
			const inserted = this.cssRules[i];
			B.resolveCss(rule, clientUrl()).catch(() => rule).then((css) => {
				const at = [...this.cssRules].indexOf(inserted);
				if (at === -1) return;
				try {
					this.deleteRule(at);
					apply(insertRule, this, [css, at]);
				} catch {}
			});
			return i;
		};
		for (const m of ["replace", "replaceSync"]) {
			const orig = SP[m];
			if (!orig) continue;
			SP[m] = function (text) {
				if (!hasVirtual(text)) return apply(orig, this, arguments);
				const r = apply(orig, this, [B.cachedCss(text)]);
				B.resolveCss(text, clientUrl()).catch(() => text).then((css) => {
					try {
						apply(SP.replaceSync, this, [css]);
					} catch {}
				});
				return r;
			};
		}
	}

	// ---- mutation observer: catch everything that reached the dom another way ----
	const OBSERVE = {
		subtree: true,
		childList: true,
		characterData: true,
		attributes: true,
		attributeFilter: ["src", "href", "srcset", "imagesrcset", "poster", "data", "style", "xlink:href", "rel", ...PENDING_ATTRS.map((a) => PENDING + a)],
	};
	let lastTitle = null;
	function checkTitle() {
		const t = call(n.title, doc);
		if (t !== lastTitle) {
			lastTitle = t;
			B.titleChanged(t);
		}
	}

	function scanEl(el) {
		if (el.localName === "style") {
			const text = call(n.textContent.get, el);
			if (hasVirtual(text)) setStyleText(el, text, (x) => apply(n.textContent.set, el, [x]));
		}
		takePending(el);
		for (const name of ["src", "href", "srcset", "imagesrcset", "poster", "data", "style"]) {
			const v = getAttr(el, name);
			if (!v || !hasVirtual(v) || isOwnWrite(el, name, v)) continue;
			// the element already started a doomed request for the virtual url; stop it
			const kind = kindFor(el, name);
			if (!kind) continue;
			if (kind !== "style" && kind !== "link") call(n.removeAttribute, el, name);
			applyAttr(el, name, v);
		}
	}
	function scanNode(node) {
		if (node.nodeType === 3) {
			const p = call(n.parentNode, node);
			if (p && p.localName === "style") scanEl(p);
			return;
		}
		if (node.nodeType !== 1 && node.nodeType !== 11) return;
		if (node.nodeType === 1) scanEl(node);
		if (node.firstElementChild) for (const el of qsa(node, SCAN_SEL)) scanEl(el);
	}
	let titleDirty = false;
	function onMutations(records) {
		for (const r of records) {
			if (r.type === "attributes") {
				const el = r.target;
				const name = r.attributeName;
				if (name.startsWith(PENDING)) takePending(el);
				else if (name === "rel") {
					if (getVirt(el, "href")) activateLink(el);
				} else {
					const v = getAttr(el, name);
					if (v && hasVirtual(v) && !isOwnWrite(el, name, v)) {
						const kind = kindFor(el, name);
						if (kind && kind !== "style" && kind !== "link") call(n.removeAttribute, el, name);
						applyAttr(el, name, v);
					}
				}
			} else if (r.type === "childList") {
				for (const node of r.addedNodes) {
					scanNode(node);
					if (isConnected(node)) activatePendingIn(node);
				}
				if (!titleDirty) {
					const t = r.target;
					if (t.localName === "title" || t.localName === "head") titleDirty = true;
				}
			} else if (r.type === "characterData") {
				const p = call(n.parentNode, r.target);
				if (p && p.localName === "style") scanEl(p);
				if (p && p.localName === "title") titleDirty = true;
			}
		}
		if (titleDirty) {
			titleDirty = false;
			checkTitle();
		}
	}
	const observer = new n.MutationObserver(onMutations);
	const observe = (root) => observer.observe(root, OBSERVE);
	observe(doc);
	if (n.attachShadow) {
		EP.attachShadow = function attachShadow() {
			const root = apply(n.attachShadow, this, arguments);
			// our devtools' own ui (lots of dom churn, never any virtual urls)
			if (this.id !== "eruda") observe(root);
			return root;
		};
	}

	// ---- navigation ----
	const nativeReplaceState = n.replaceState;
	// scramjet deletes window.navigation (it would leak real urls); keep our own handle
	const navObj = win.navigation;
	// Chrome switches the Navigation API's events (and entries) off for initial about:blank
	// documents and at opaque origins; currentEntry is null exactly then. Without them,
	// links, forms and the rest are caught below by hand. Checked per document.
	const navEventsWork = () => {
		try {
			return !!navObj && typeof navObj.addEventListener === "function" && navObj.currentEntry !== null;
		} catch {
			return false;
		}
	};
	let hasNavigationApi = navEventsWork();
	const historyInner = {};
	// virtual url per session history entry, for when the real url can't carry it
	const entryUrls = new _Map();
	const entryKey = () => {
		try {
			return navObj && navObj.currentEntry ? navObj.currentEntry.key : null;
		} catch {
			return null;
		}
	};
	// without entry keys, the virtual url rides along in the entry's state instead; the page
	// only ever sees its own state
	const STATE_KEY = "__sjlUrl";
	const isWrapped = (st) => st !== null && typeof st === "object" && _Object.prototype.hasOwnProperty.call(st, STATE_KEY);
	const unwrapState = (st) => (isWrapped(st) ? st.s : st);
	const historyState = getDesc(win.History.prototype, "state");
	for (const proto of [win.History.prototype, win.PopStateEvent && win.PopStateEvent.prototype]) {
		const d = proto && getDesc(proto, "state");
		if (!d || !d.get) continue;
		defineProperty(proto, "state", {
			...d,
			get() {
				return unwrapState(apply(d.get, this, []));
			},
		});
	}
	function rememberEntry(url) {
		const k = entryKey();
		if (k) return void entryUrls.set(k, url);
		try {
			const st = unwrapState(apply(historyState.get, win.history, []));
			apply(nativeReplaceState, win.history, [{ [STATE_KEY]: url, s: st }, ""]);
		} catch {}
	}
	function restoreEntry() {
		const k = entryKey();
		if (k) {
			if (entryUrls.has(k)) B.setVirtualUrl(entryUrls.get(k));
			return;
		}
		try {
			const st = apply(historyState.get, win.history, []);
			if (isWrapped(st)) B.setVirtualUrl(st[STATE_KEY]);
		} catch {}
	}
	for (const m of ["pushState", "replaceState"]) {
		const orig = n[m];
		win.History.prototype[m] = historyInner[m] = function () {
			let r;
			const url = arguments[2];
			try {
				r = apply(orig, this, arguments);
			} catch (e) {
				// blob:/srcdoc-hosted: the real document can't take an http(s) url. keep the
				// entry, track the url ourselves
				if (!(typeof url === "string" && isVirtual(url))) throw e;
				r = apply(orig, this, [arguments[0], arguments[1]]);
			}
			B.historyChanged(this, typeof url === "string" ? url : null, m === "pushState");
			return r;
		};
	}

	/**
	 * A url the browser resolved against the frame's real url or base url, when those aren't
	 * the virtual one (a blob: document, or a srcdoc one, whose base is the app's url):
	 * `<form>` without an action, `?page=2`, `#top`. Those mean the page's own url. Returns
	 * the virtual url, or null.
	 */
	function ownUrl(dest) {
		let real;
		try {
			real = win.location.href;
		} catch {
			return null;
		}
		if (isVirtual(real) || typeof dest !== "string") return null;
		for (const u of [real, doc ? doc.baseURI : real]) {
			const base = u.split(/[?#]/)[0];
			if (!dest.startsWith(base) || /^[^?#]/.test(dest.slice(base.length))) continue;
			try {
				const page = new _URL(dest.slice(base.length), B.unrewrite(clientUrl()));
				return B.rewrite(page.href, clientUrl());
			} catch {
				return null;
			}
		}
		return null;
	}

	let lastSubmit = null;
	function encodeForm(fd, submit) {
		const form = submit && submit.form;
		const enctype = ((submit && submit.submitter && submit.submitter.getAttribute("formenctype")) || (form && form.getAttribute("enctype")) || "application/x-www-form-urlencoded").toLowerCase();
		if (enctype === "multipart/form-data") {
			const req = new _Request("https://x.invalid/", { method: "POST", body: fd });
			return req.arrayBuffer().then((body) => ({ body, type: req.headers.get("content-type") }));
		}
		if (enctype === "text/plain") {
			let s = "";
			for (const [k, v] of fd) s += k + "=" + (typeof v === "string" ? v : v.name) + "\r\n";
			return _Promise.resolve({ body: s, type: "text/plain" });
		}
		const params = new _URLSearchParams();
		for (const [k, v] of fd) params.append(k, typeof v === "string" ? v : v.name);
		return _Promise.resolve({ body: params.toString(), type: "application/x-www-form-urlencoded" });
	}

	/**
	 * A same-document fragment navigation. Never through a relative url: a srcdoc document
	 * resolves those against the app's url. And a document whose url is blob:null (written by
	 * an app running at blob:null) can't navigate at all, not even to a fragment: there it's
	 * done by hand.
	 */
	function goFragment(hash, replace) {
		let real;
		try {
			real = win.location.href;
		} catch {
			return false;
		}
		const base = real.split("#")[0];
		if (!base.startsWith("blob:null/")) {
			try {
				if (replace) win.location.replace(base + hash);
				else win.location.hash = hash;
				return true;
			} catch {
				return false;
			}
		}
		const oldURL = B.unrewrite(clientUrl());
		try {
			apply(replace ? nativeReplaceState : n.pushState, win.history, [null, "", base + hash]);
		} catch {
			return false;
		}
		B.historyChanged(win.history, null, !replace);
		let id = hash.slice(1);
		try {
			id = decodeURIComponent(id);
		} catch {}
		const el = id && (doc.getElementById(id) || doc.getElementsByName(id)[0]);
		if (el) el.scrollIntoView();
		else if (!id || id.toLowerCase() === "top") win.scrollTo(0, 0);
		apply(dispatch, win, [new win.HashChangeEvent("hashchange", { oldURL, newURL: B.unrewrite(clientUrl()) })]);
		return true;
	}

	function navigateTo(url, init) {
		if (!init || (!init.method && !init.reload)) {
			// only the fragment changes: a same-document navigation, no reload
			const to = B.unrewrite(url);
			const at = to.indexOf("#");
			if (at !== -1 && to.slice(0, at) === B.unrewrite(clientUrl()).split("#")[0] && goFragment(to.slice(at), !!(init && init.replace)))
				return;
		}
		B.navigate(url, { referrer: clientUrl(), ...init });
	}

	// scramjet blanks link/form targets (with a service worker it routes _top and friends
	// itself) and keeps the page's value here
	const targetOf = (el, attr = "target") => {
		const orig = getAttr(el, "scramjet-attr-" + attr);
		return orig !== null ? orig : getAttr(el, attr) || "";
	};

	const isSelfTarget = (target) => {
		const t = (target || "").toLowerCase();
		return !t || t === "_self" || t === (win.name || "").toLowerCase();
	};

	/** A link or form went to `target` (a window name, _self, _top...). */
	function navigateTarget(target, url, init) {
		const t = (target || "").toLowerCase();
		if (isSelfTarget(t)) return navigateTo(url, init);
		if (t !== "_blank" && B.navigateTarget(target, url, { referrer: clientUrl(), ...init })) return;
		// no window has that name: a browser opens one, with that name
		B.open(url, false, win, t === "_blank" ? undefined : target);
	}

	function onNavigate(e) {
		let dest = e.destination && e.destination.url;
		if (!dest) return;
		if (e.downloadRequest !== null && e.downloadRequest !== undefined) {
			if (isVirtual(dest) && e.cancelable) {
				e.preventDefault();
				B.download(dest, e.downloadRequest || undefined);
			}
			return;
		}
		if (!e.cancelable || e.hashChange || e.destination.sameDocument) return;
		if (e.navigationType === "reload" && !isVirtual(dest)) {
			e.preventDefault();
			navigateTo(clientUrl(), { reload: true });
			return;
		}
		if (!isVirtual(dest)) dest = ownUrl(dest) || dest;
		if (isVirtual(dest)) {
			e.preventDefault();
			const init = { replace: e.navigationType === "replace", reload: e.navigationType === "reload" };
			if (e.formData) {
				const submit = lastSubmit;
				encodeForm(e.formData, submit).then(({ body, type }) =>
					navigateTo(dest, { ...init, method: "POST", body, headers: [["Content-Type", type]] })
				);
			} else navigateTo(dest, init);
		} else if (dest.startsWith(B.hostOrigin + "/")) {
			// a real url on our own host: something un-proxied leaked. don't load the proxy into itself
			e.preventDefault();
		}
	}

	// new-window link targets never reach our navigate listener, so handle them up front
	function anchorFor(e) {
		const path = e.composedPath ? e.composedPath() : [e.target];
		for (const node of path) {
			if (node && (node.localName === "a" || node.localName === "area") && node.namespaceURI !== SVG_NS) return node;
		}
		return null;
	}
	// capture phase: things that would open a real browser window must be stopped before
	// the default action, and pages rarely cancel those themselves
	function onClickCapture(e) {
		if (e.button !== 0 && e.button !== 1) return;
		const a = anchorFor(e);
		if (!a) return;
		const href = call(a.localName === "a" ? n.anchorHref : n.areaHref, a);
		if (!isVirtual(href) || call(n.hasAttribute, a, "download")) return;
		const target = targetOf(a).toLowerCase();
		const newWindow = e.button === 1 || e.ctrlKey || e.metaKey || e.shiftKey || target === "_blank";
		if (!newWindow) return;
		e.preventDefault();
		B.open(href, e.button === 1 || e.ctrlKey || e.metaKey);
	}
	// bubble phase: only after the page had its chance to handle (and cancel) the click
	function onClickBubble(e) {
		if (e.defaultPrevented || e.button !== 0) return;
		const a = anchorFor(e);
		if (!a) return;
		let href = call(a.localName === "a" ? n.anchorHref : n.areaHref, a);
		if (!isVirtual(href)) {
			// "?page=2" and friends, resolved against a blob:/srcdoc frame url
			if (hasNavigationApi || !(href = ownUrl(href))) return;
		}
		if (call(n.hasAttribute, a, "download")) {
			if (hasNavigationApi) return; // the navigate event reports downloads
			e.preventDefault();
			B.download(href, getAttr(a, "download") || undefined);
			return;
		}
		const target = targetOf(a);
		// the navigate event only fires in the window being navigated; a link into another
		// frame or the tab is taken here even when it would fire there
		if (hasNavigationApi && isSelfTarget(target)) return;
		e.preventDefault();
		navigateTarget(target, href, {});
	}

	function submitForm(form, submitter) {
		const sub = submitter || null;
		// natives: scramjet's getters hand the page real urls
		const subAction = sub && sub.hasAttribute("formaction") && (sub.localName === "button" ? n.buttonFormAction : n.inputFormAction);
		let action = (subAction && call(subAction, sub)) || call(n.formAction, form);
		if (!isVirtual(action)) action = ownUrl(action);
		if (!action) return false;
		const method = ((sub && sub.getAttribute("formmethod")) || form.getAttribute("method") || "get").toLowerCase();
		if (method === "dialog") return false;
		const target = (sub && targetOf(sub, "formtarget")) || targetOf(form);
		let fd;
		try {
			fd = new win.FormData(form, sub || undefined);
		} catch {
			fd = new win.FormData(form);
		}
		if (method === "post") {
			encodeForm(fd, { form, submitter: sub }).then(({ body, type }) =>
				navigateTarget(target, action, { method: "POST", body, headers: [["Content-Type", type]] })
			);
		} else {
			const u = new _URL(action);
			const params = new _URLSearchParams();
			for (const [k, v] of fd) params.append(k, typeof v === "string" ? v : v.name);
			u.search = params.toString();
			navigateTarget(target, u.href, {});
		}
		return true;
	}
	function onSubmitCapture(e) {
		lastSubmit = { form: e.target, submitter: e.submitter, time: Date.now() };
	}
	function onSubmit(e) {
		if (e.defaultPrevented) return;
		const form = e.target;
		const target = (e.submitter && targetOf(e.submitter, "formtarget")) || targetOf(form);
		// with the Navigation API, a submission into this window arrives as a navigate event
		if (hasNavigationApi && isSelfTarget(target)) return;
		if (submitForm(form, e.submitter)) e.preventDefault();
	}
	// form.submit() fires no submit event
	{
		const FP = win.HTMLFormElement.prototype;
		const nativeSubmit = FP.submit;
		FP.submit = function submit() {
			if ((!hasNavigationApi || !isSelfTarget(targetOf(this))) && submitForm(this, null)) return;
			return apply(nativeSubmit, this, arguments);
		};
	}

	// <meta http-equiv=refresh>: prepareHtml renames them so the browser doesn't navigate the
	// frame itself (impossible to catch without the Navigation API); we schedule it here
	let refreshTimer = null;
	function scheduleRefresh() {
		_clearTimeout(refreshTimer);
		const meta = apply(n.docQsa, doc, ['meta[http-equiv="x-sjl-refresh"]'])[0];
		if (!meta) return;
		const m = /^\s*(\d+(?:\.\d*)?)?\s*(?:[;,]\s*(?:url\s*=\s*)?(["']?)(.*?)\2\s*)?$/i.exec(getAttr(meta, "content") || "");
		if (!m || (m[1] === undefined && !m[3])) return;
		const delay = (parseFloat(m[1] || "0") || 0) * 1000;
		let url = m[3] || "";
		refreshTimer = _setTimeout(() => {
			if (!url) return navigateTo(clientUrl(), { replace: true, reload: true });
			if (!isVirtual(url)) url = B.rewrite(url, clientUrl());
			navigateTo(url, { replace: true });
		}, delay);
	}

	function onKey(e) {
		const k = e.key;
		const ctrl = e.ctrlKey || e.metaKey;
		const interesting = (ctrl && /^[tlwr]$/i.test(k)) || k === "F5" || k === "F12" || k === "Escape" || (e.altKey && (k === "ArrowLeft" || k === "ArrowRight")) || (ctrl && e.shiftKey && /^[tijc]$/i.test(k));
		if (!interesting) return;
		// Escape is also forwarded (with repeat) so a held Esc can leave our fallback
		// fullscreen; shortcut() returns false for it otherwise, so the page still gets it
		if (B.shortcut({ key: k, ctrl, alt: e.altKey, shift: e.shiftKey, meta: e.metaKey, repeat: e.repeat })) e.preventDefault();
	}

	let listeners = [];
	function listen(target, type, fn, opts) {
		apply(addListener, target, [type, fn, opts]);
		listeners.push([target, type, fn, opts]);
	}
	function installListeners() {
		// document.open() erases window listeners, so (re)install after every write
		const remove = EventTarget.prototype.removeEventListener;
		for (const [t, type, fn, opts] of listeners) apply(remove, t, [type, fn, opts]);
		listeners = [];
		hasNavigationApi = navEventsWork();
		if (hasNavigationApi) listen(navObj, "navigate", onNavigate);
		listen(win, "click", onClickCapture, true);
		listen(win, "auxclick", onClickCapture, true);
		listen(win, "click", onClickBubble, false);
		listen(win, "submit", onSubmitCapture, true);
		listen(win, "submit", onSubmit, false);
		listen(win, "keydown", onKey, true);
		listen(win, "popstate", () => {
			restoreEntry();
			B.urlChanged();
		}, true);
		listen(win, "hashchange", () => B.urlChanged());
		// the document is going away: its sockets and streams go with it
		listen(win, "pagehide", (e) => {
			_clearTimeout(refreshTimer);
			e.persisted || B.closed();
		});
		listen(win, "DOMContentLoaded", () => {
			// some pages never reach "load" (long-lived subresources); don't spin forever
			_setTimeout(() => B.loaded(), 4000);
			checkTitle();
			for (const el of apply(n.docQsa, doc, [SCAN_SEL])) scanEl(el);
			activatePendingIn(doc);
			scheduleRefresh();
		});
		// Chrome doesn't fire window "load" for a document written with document.open() and
		// write(), which is how every page gets here; its readyState still reaches "complete"
		let loadDone = false;
		const onLoad = () => {
			if (loadDone) return;
			loadDone = true;
			checkTitle();
			findIcon();
			B.loaded();
		};
		listen(win, "load", onLoad);
		listen(doc, "readystatechange", () => doc.readyState === "complete" && onLoad());
	}
	installListeners();

	let iconFound = false;
	function findIcon() {
		if (iconFound) return;
		iconFound = true;
		const link = apply(n.docQsa, doc, ['link[rel~="icon"],link[rel="shortcut icon"],link[rel~="apple-touch-icon"]'])[0];
		if (link && getVirt(link, "href")) return; // activateLink reports it
		try {
			const origin = new _URL(B.unrewrite(clientUrl())).origin;
			if (!/^https?:/.test(origin)) return B.iconChanged(null);
			B.resolve(B.rewrite(origin + "/favicon.ico", clientUrl()), "image", clientUrl()).then(
				(u) => B.iconChanged(u || null),
				() => B.iconChanged(null)
			);
		} catch {
			B.iconChanged(null);
		}
	}

	// ---- window.open: new tabs in our UI instead of real popups ----
	win.open = function open(url, target, features) {
		const u = url === undefined || url === null ? "" : _String(url);
		const t = target === undefined || target === null || target === "" ? "_blank" : _String(target);
		const noopener = /(^|,)\s*noopener\s*(=\s*(yes|1|true))?\s*(,|$)/i.test(_String(features || ""));
		if (u && !isVirtual(u) && !u.startsWith("about:")) return apply(n.open, this, arguments);
		if (t.toLowerCase() !== "_blank") {
			// _self/_parent/_top, or a window by name: navigated (or just looked up, without
			// a url) in place
			const w = B.navigateTarget(t, isVirtual(u) ? u : null, { referrer: clientUrl() });
			if (w) return noopener ? null : w;
		}
		// a new tab; a named one can be found by that name later
		const w = B.open(u || null, false, win, t.toLowerCase() === "_blank" ? undefined : t);
		if (w && !noopener) {
			try {
				defineProperty(w, "opener", { value: win, writable: true, configurable: true });
			} catch {}
		}
		return noopener ? null : w;
	};

	// ---- import maps for module cycles ----
	const mapped = new _Set();
	function addImportMap(entries) {
		const fresh = {};
		let any = false;
		for (const k in entries) {
			if (mapped.has(k)) continue;
			mapped.add(k);
			fresh[k] = entries[k];
			any = true;
		}
		if (!any) return;
		const s = call(n.createElement, doc, "script");
		call(n.setAttribute, s, "type", "importmap");
		apply(n.textContent.set, s, [_JSON.stringify({ imports: fresh })]);
		const head = call(n.head, doc) || doc.documentElement;
		call(n.prepend, head, s);
	}

	return {
		functionForScramjet,
		afterHook(client) {
			unshadowServiceWorker();
			// scramjet doesn't cover these html sinks; route them through its rewriter
			const rewriteHtml = (html) => {
				try {
					return win.$scramjet.rewriteHtml(_String(html), client.context, client.meta, {
						loadScripts: false,
						inline: true,
						source: client.url.href,
						apisource: "sjl",
					});
				} catch {
					return html;
				}
			};
			const shadowHTML = getDesc(win.ShadowRoot.prototype, "innerHTML");
			if (shadowHTML) {
				defineProperty(win.ShadowRoot.prototype, "innerHTML", {
					...shadowHTML,
					set(v) {
						apply(shadowHTML.set, this, [markPending(rewriteHtml(v))]);
						resolveMarked(this);
					},
				});
			}
			const ccf = win.Range.prototype.createContextualFragment;
			win.Range.prototype.createContextualFragment = function (html) {
				const frag = apply(ccf, this, [markPending(rewriteHtml(html))]);
				resolveMarked(frag);
				return frag;
			};
			// scramjet stringifies a missing url argument into "undefined"; calls without
			// a url must not change the url at all, so skip its hook for those
			for (const m of ["pushState", "replaceState"]) {
				const hooked = win.History.prototype[m];
				const inner = historyInner[m];
				win.History.prototype[m] = new Proxy(hooked, {
					apply(target, self, args) {
						if (args.length < 3 || args[2] === undefined || args[2] === null) {
							return apply(inner, self, [args[0], args[1] ?? ""]);
						}
						return apply(target, self, args);
					},
				});
			}
			rememberEntry(clientUrl());
			B.urlChanged();
		},
		documentReset() {
			rememberEntry(clientUrl());
			iconFound = false;
			lastTitle = null;
			installListeners();
			observe(doc);
			B.urlChanged();
		},
		addImportMap,
		rememberEntry,
		goFragment,
		// developer tools (src/ui/devtools.ts): run our own bundled script in this realm
		// without scramjet rewriting it...
		runRaw(src, names, args) {
			return apply(apply(_Function, null, [...names, src]), win, args);
		},
		// ...and evaluate console input the way the page's own code runs: rewritten, global
		evalAsPage(code) {
			const rewrite = win.$scramjet$rewrite;
			code = _String(code);
			return nativeEval(typeof rewrite === "function" ? rewrite(code) : code);
		},
	};
}
