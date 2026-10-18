// What a proxied realm (a page, a frame, and the workers it started) has open on the network.
//
// A browser closes a document's WebSockets and stops its downloads when the document goes
// away. Here those connections live in the top page, inside the wisp transport, so without
// this they outlive their page: sockets keep delivering messages into a page nobody can
// see, streamed responses (event streams, long polls, media) keep downloading, and every
// callback they hold keeps that dead page's whole JS heap reachable. Closing a RealmNet
// shuts all of that down.

import type { ProxyTransport, RawHeaders } from "@mercuryworkshop/proxy-transports";

const portClose = MessagePort.prototype.close;
type Closer = (code: number, reason: string) => void;

let openSockets = 0;
/** sockets that proxied realms currently hold open (for the debug stats) */
export const realmSocketCount = () => openSockets;

export class RealmNet {
	dead = false;
	private sockets = new Set<Closer>();
	private ports = new Set<MessagePort>();
	private ctl = new AbortController();

	constructor(private transport: ProxyTransport) {}

	connect(
		url: URL,
		protocols: string[],
		headers: RawHeaders,
		onopen: (protocol: string, extensions: string) => void,
		onmessage: (data: any) => void,
		onclose: (code: number, reason: string) => void,
		onerror: (error: string) => void
	): [(data: any) => void, Closer] {
		if (this.dead) return [() => {}, () => {}];
		let open = true;
		let close: Closer = () => {};
		const closer: Closer = (code, reason) => {
			finish();
			close(code, reason);
		};
		openSockets++;
		this.sockets.add(closer);
		const finish = () => {
			if (!open) return;
			open = false;
			openSockets--;
			this.sockets.delete(closer);
		};
		// never call back into a realm that's gone: its handlers would still run
		const [send, realClose] = this.transport.connect(
			url,
			protocols,
			headers,
			(p, e) => !this.dead && onopen(p, e),
			(d) => !this.dead && onmessage(d),
			(code, reason) => (finish(), !this.dead && onclose(code, reason)),
			(err) => (finish(), !this.dead && onerror(err))
		);
		close = realClose;
		return [send, closer];
	}

	/** A WebSocket-only transport for this realm's scramjet client. */
	static transportFor(get: () => RealmNet, transport: ProxyTransport): ProxyTransport {
		return {
			get ready() {
				return transport.ready;
			},
			init: () => transport.init(),
			request: (...args) => transport.request(...args),
			connect: (...args) => get().connect(...args),
		};
	}

	/**
	 * Hand a response to this realm. A streamed body is piped through a stream we can cut,
	 * so closing the realm cancels the download even while the page holds a reader on it.
	 */
	guard<T extends { body: any }>(res: T): T {
		const body = res.body;
		if (this.dead) {
			try {
				if (body instanceof ReadableStream && !body.locked) body.cancel().catch(() => {});
			} catch {}
			throw new DOMException("The document was unloaded", "AbortError");
		}
		if (!(body instanceof ReadableStream)) return res;
		const pipe = new TransformStream();
		body.pipeTo(pipe.writable, { signal: this.ctl.signal }).catch(() => {});
		return { ...res, body: pipe.readable };
	}

	/** A MessagePort to a worker this realm started (closed with the realm). */
	addPort(port: MessagePort) {
		if (this.dead) portClose.call(port);
		else this.ports.add(port);
	}

	close() {
		if (this.dead) return;
		this.dead = true;
		this.ctl.abort();
		for (const c of [...this.sockets]) {
			try {
				// 1001 "going away": what a browser sends when a page is navigated away from
				c(1001, "");
			} catch {}
		}
		this.sockets.clear();
		for (const p of this.ports) {
			try {
				portClose.call(p);
			} catch {}
		}
		this.ports.clear();
	}
}
