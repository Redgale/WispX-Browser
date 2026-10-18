// Developer tools for the page in a tab: Eruda (console, elements, network, storage,
// sources) running inside the tab's proxied document, docked at the bottom of the page.
//
// Chrome's own DevTools can't be embedded in a web page (they need a debugging connection
// only the browser has), and they're often switched off on managed devices, so this brings
// an in-page equivalent. It runs in the page's realm, so it sees the page the way the page
// sees itself: console input is rewritten by scramjet exactly like the page's own scripts
// (`location.href` is the site's url, `fetch("/api")` goes through the proxy), and storage
// and cookies are the site's.
//
// Opened for a tab, it stays open across that tab's navigations. While it's open, a new
// document's console output is buffered from its very first script, and handed to Eruda
// once the document has been parsed, like reloading with DevTools open in Chrome.

import erudaRaw from "eruda/eruda.js?raw";
import type { Controller, RealmState } from "../proxy/controller";
import { REALM } from "../proxy/controller";

// the bundle points at a source map we don't ship
const ERUDA_SOURCE = erudaRaw.replace(/\/\/# sourceMappingURL=eruda\.js\.map\s*$/, "") + "\n//# sourceURL=eruda.js";

const LEVELS = ["log", "info", "warn", "error", "debug"] as const;
type Level = (typeof LEVELS)[number];
const MAX_BUFFERED = 1000;

const listen = EventTarget.prototype.addEventListener;
const unlisten = EventTarget.prototype.removeEventListener;

type Buffer = { entries: Array<[Level, any[]]>; stop(): void };

export type Panel = "console" | "elements" | "network" | "resources" | "sources" | "info";

/** The part of a tab the devtools need. */
export interface DevtoolsTab {
	frame: HTMLIFrameElement | null;
}

/**
 * Scramjet pins console.log so sites can't silence it (an anti-anti-debugging measure):
 * assignments to it are ignored. That would also stop us from capturing it, so on a page
 * the devtools are attached to, make it a plain property again.
 */
function unlockConsoleLog(win: any) {
	const con = win.console;
	const desc = Object.getOwnPropertyDescriptor(con, "log");
	if (!desc?.get || !desc.configurable) return;
	Object.defineProperty(con, "log", {
		value: desc.get.call(con),
		writable: true,
		configurable: true,
		enumerable: desc.enumerable,
	});
}

function realmOf(win: any): RealmState | undefined {
	try {
		return Object.prototype.hasOwnProperty.call(win, REALM) ? win[REALM] : undefined;
	} catch {
		return undefined;
	}
}

export class DevTools {
	private open = new WeakSet<DevtoolsTab>();
	// keyed by the realm, not the window: a frame's WindowProxy stays the same object across
	// navigations, while each document gets a realm of its own
	private instances = new WeakMap<RealmState, any>();
	private buffers = new WeakMap<RealmState, Buffer>();
	onchange: (tab: DevtoolsTab) => void = () => {};

	constructor(private ctrl: Controller) {}

	isOpen(tab: DevtoolsTab | null) {
		return !!tab && this.open.has(tab);
	}

	toggle(tab: DevtoolsTab, panel?: Panel) {
		if (this.open.has(tab) && !panel) this.close(tab);
		else this.show(tab, panel);
	}

	show(tab: DevtoolsTab, panel?: Panel) {
		this.open.add(tab);
		const win = this.pageWindow(tab);
		if (win) this.attach(win, panel ?? "console");
		this.onchange(tab);
	}

	close(tab: DevtoolsTab) {
		this.open.delete(tab);
		const state = realmOf(this.pageWindow(tab));
		// closed while the page was still loading: stop buffering its console
		if (state) {
			this.buffers.get(state)?.stop();
			this.buffers.delete(state);
		}
		const eruda = state && this.instances.get(state);
		if (eruda) {
			try {
				// destroy, not hide: it hooks the page's console and network while it exists
				eruda.destroy();
			} catch {}
			this.instances.delete(state);
		}
		this.onchange(tab);
	}

	/** Called between document.open() and write() of a tab's new top document. */
	beforeWrite(tab: DevtoolsTab, win: any) {
		if (this.open.has(tab)) this.buffer(win);
	}

	/** Called once a tab's new top document has been written. */
	documentWritten(tab: DevtoolsTab, win: any) {
		if (!this.open.has(tab)) return;
		// (it may have been closed again by the time the page is parsed)
		const start = () => this.open.has(tab) && this.attach(win, null);
		if (win.document.readyState === "loading") listen.call(win, "DOMContentLoaded", start, { once: true });
		else start();
	}

	private pageWindow(tab: DevtoolsTab): any {
		const win = tab.frame?.contentWindow;
		return win && realmOf(win)?.written ? win : null;
	}

	/** Record console output and errors until Eruda is up to take over. */
	private buffer(win: any) {
		const state = realmOf(win);
		if (!state) return;
		unlockConsoleLog(win);
		const con = win.console;
		const entries: Buffer["entries"] = [];
		const push = (level: Level, args: any[]) => {
			entries.push([level, args]);
			if (entries.length > MAX_BUFFERED) entries.shift();
		};
		const orig: Partial<Record<Level, any>> = {};
		for (const level of LEVELS) {
			const fn = con[level];
			orig[level] = fn;
			con[level] = function (...args: any[]) {
				push(level, args);
				return fn.apply(this, args);
			};
		}
		const onError = (e: ErrorEvent) => push("error", [e.error ?? e.message]);
		const onRejection = (e: PromiseRejectionEvent) => push("error", ["Uncaught (in promise)", e.reason]);
		listen.call(win, "error", onError);
		listen.call(win, "unhandledrejection", onRejection);
		this.buffers.set(state, {
			entries,
			stop() {
				for (const level of LEVELS) con[level] = orig[level];
				unlisten.call(win, "error", onError);
				unlisten.call(win, "unhandledrejection", onRejection);
			},
		});
	}

	private attach(win: any, panel: Panel | null) {
		const state = realmOf(win);
		if (!state?.sink?.runRaw || state.net.dead) return;
		let eruda = this.instances.get(state);
		if (!eruda) {
			const buffered = this.buffers.get(state);
			buffered?.stop();
			this.buffers.delete(state);
			try {
				eruda = this.create(win, state);
			} catch (e) {
				console.error("[sjl] devtools failed to start", e);
				return;
			}
			this.instances.set(state, eruda);
			const console_ = eruda.get("console");
			for (const [level, args] of buffered?.entries ?? []) {
				try {
					console_[level](...args);
				} catch {}
			}
		}
		// show() opens the panel; show(name) only switches tools
		eruda.show();
		if (panel) eruda.show(panel);
	}

	private create(win: any, state: RealmState) {
		unlockConsoleLog(win);
		const module = { exports: {} as any };
		// run the bundle in the page's realm, unrewritten (it's our code, not the site's), but
		// hand its console an eval that runs input as if the page had written it
		state.sink.runRaw(
			ERUDA_SOURCE,
			["module", "exports", "define", "eval"],
			[module, module.exports, undefined, (code: string) => state.sink.evalAsPage(code)]
		);
		const eruda = module.exports.default ?? module.exports;
		const dark = matchMedia("(prefers-color-scheme: dark)").matches;
		eruda.init({
			useShadowDom: true,
			autoScale: false,
			defaults: { displaySize: 45, transparency: 1, theme: dark ? "Dark" : "Light" },
		});
		// we open and close it from the toolbar instead of its floating button
		eruda.get("entryBtn")?.hide();
		const info = eruda.get("info");
		info?.add?.("Proxy", () => {
			const s = this.ctrl.stats();
			return `<pre style="margin:0;white-space:pre-wrap">${Object.entries(s)
				.map(([k, v]) => `${k}: ${String(v).replace(/[<&]/g, (c) => (c === "<" ? "&lt;" : "&amp;"))}`)
				.join("\n")}</pre>`;
		});
		return eruda;
	}
}
