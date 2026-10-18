// Worker bootstrap. Every proxied `new Worker(url)` actually starts this script (from a
// blob url). The page posts a boot message first; we build a proxied realm around it
// (scramjet + the same sink layer as windows, talking to the controller over a
// MessagePort), then run the worker's rewritten code. Messages the page posts before
// that are held and replayed, so the worker sees them in order.
(() => {
	"use strict";
	// scramjet hooks MessagePort/postMessage once it's running; keep the originals
	const add = EventTarget.prototype.addEventListener;
	const portPost = MessagePort.prototype.postMessage;
	const portStart = MessagePort.prototype.start;
	const dispatch = EventTarget.prototype.dispatchEvent;
	const _MessageEvent = MessageEvent;
	const _MessageChannel = MessageChannel;
	const nativeImportScripts = typeof importScripts === "function" ? importScripts : null;
	const queue = [];
	const connects = [];
	let booted = false;
	let ready = false;

	const early = (e) => {
		const d = e.data;
		if (d && typeof d === "object" && d.__sjlconnect) {
			e.stopImmediatePropagation();
			if (ready) fireConnect(e.ports[0]);
			else connects.push(e.ports[0]);
			return;
		}
		if (ready) return;
		e.stopImmediatePropagation();
		if (!booted && d && typeof d === "object" && d.__sjlboot) {
			booted = true;
			start(d.__sjlboot).catch((err) => {
				console.error("[sjl] worker failed to start", err);
				setTimeout(() => {
					throw err;
				});
			});
			return;
		}
		queue.push(e);
	};
	add.call(self, "message", early);

	function fireConnect(port) {
		dispatch.call(self, new _MessageEvent("connect", { ports: [port], data: "" }));
	}

	function makeRpc(port) {
		let next = 0;
		const waiting = new Map();
		add.call(port, "message", ({ data }) => {
			const w = waiting.get(data.id);
			if (!w) return;
			waiting.delete(data.id);
			if (data.ok) w.res(data.value);
			else w.rej(new Error(data.error));
		});
		portStart.call(port);
		return {
			call(op, args, transfer = []) {
				return new Promise((res, rej) => {
					const id = ++next;
					waiting.set(id, { res, rej });
					portPost.call(port, { id, op, args }, transfer);
				});
			},
		};
	}

	// scramjet derives the worker's url from self.location, which is our boot blob.
	// give it the virtual url the worker would have had under a service worker.
	function installLocation(virtualUrl) {
		const u = new URL(virtualUrl);
		const proto = self.WorkerLocation ? self.WorkerLocation.prototype : Object.prototype;
		const loc = Object.create(proto);
		for (const k of ["href", "origin", "protocol", "host", "hostname", "port", "pathname", "search", "hash"]) {
			Object.defineProperty(loc, k, { get: () => u[k], enumerable: true });
		}
		Object.defineProperty(loc, "toString", { value: () => u.href });
		Object.defineProperty(self, "location", { get: () => loc, configurable: true });
	}

	// before scramjet hooks eval: the worker's code arrives already rewritten
	const nativeEval = self.eval;

	async function start(boot) {
		installLocation(boot.url);
		// scramjet's source comes with the boot message: nothing to fetch, and no blob: url
		// to load, which a worker at an opaque origin can't always do
		new Function(boot.scramjetSource)();
		const sj = self.$scramjet;
		sj.setWasm(boot.wasm);

		const rpc = makeRpc(boot.port);
		const codecEncode = (u) => (u ? encodeURIComponent(u) : u);
		const codecDecode = (u) => (u ? decodeURIComponent(u) : u);
		const prefix = new URL(boot.prefix);
		const jar = new sj.CookieJar();
		jar.load(boot.cookies);
		const context = {
			config: boot.sjconfig,
			prefix,
			cookieJar: jar,
			interface: {
				codecEncode,
				codecDecode,
				getInjectScripts: () => [],
				getWorkerInjectScripts: () => "",
			},
		};

		const bridge = {
			prefix: prefix.href,
			prefixPath: prefix.pathname,
			hostOrigin: prefix.origin,
			importScriptsMap: {},
			clientUrl: () => boot.url,
			serve: (req) => rpc.call("serve", req, req.body instanceof ArrayBuffer ? [req.body] : []),
			resolve: (url, kind) => rpc.call("resolve", { url, kind }),
			unrewrite: (url) => sj.unrewriteUrl(url, context),
		};
		const sink = new Function("bridge", boot.sinkSource)(bridge);

		const transport = {
			ready: true,
			init: async () => {},
			request: () => Promise.reject(new Error("workers fetch through the sink layer")),
			connect(url, protocols, headers, onopen, onmessage, onclose, onerror) {
				const ch = new _MessageChannel();
				const port = ch.port1;
				add.call(port, "message", ({ data }) => {
					if (data.type === "open") onopen(data.protocol || "", data.extensions || "");
					else if (data.type === "data") onmessage(data.data);
					else if (data.type === "close") onclose(data.code, data.reason);
					else if (data.type === "error") onerror(data.error);
				});
				portStart.call(port);
				rpc.call("connect", { url: url.href, protocols, headers, port: ch.port2 }, [ch.port2]);
				return [
					(d) => portPost.call(port, { type: "data", data: d }, d instanceof ArrayBuffer ? [d] : []),
					(code, reason) => portPost.call(port, { type: "close", code, reason }),
				];
			},
		};

		const client = new sj.ScramjetClient(self, {
			context,
			transport,
			sendSetCookie: async (cookies) =>
				rpc.call("setCookies", cookies.map((c) => ({ url: String(c.url), cookie: c.cookie }))),
			shouldBlockMessageEvent: () => false,
			hookSubcontext: () => null,
			initHeaders: [],
			history: [],
		});
		client.natives.store["Function"] = sink.functionForScramjet;
		client.hook();
		sink.afterHook(client);

		const res = await rpc.call("resolveWorker", { url: boot.url, isModule: boot.isModule });
		if (!res || !res.code) throw new Error("failed to load worker script " + bridge.unrewrite(boot.url));
		Object.assign(bridge.importScriptsMap, res.scripts || {});

		// every worker boots as a classic one (a module worker can't start from a blob: url at
		// an opaque origin); a module worker's code runs as a module through import()
		if (boot.isModule) await import(res.code);
		else {
			try {
				// the native one: scramjet's hook would push our blob url into the virtual space
				nativeImportScripts(res.code);
			} catch (e) {
				// file: pages can't load blob: scripts into workers; run the text instead
				if (typeof res.text !== "string") throw e;
				(0, nativeEval)(res.text);
			}
		}

		ready = true;
		for (const e of queue.splice(0)) {
			// scramjet only unwraps its envelope on trusted events, and a replay isn't one
			let data = e.data;
			if (data && typeof data === "object" && "$scramjet$data" in data) data = data.$scramjet$data;
			dispatch.call(self, new _MessageEvent("message", { data, ports: [...e.ports] }));
		}
		for (const p of connects.splice(0)) fireConnect(p);
	}
})();
