import type { Controller, NavInit, TabHost } from "../proxy/controller";
import { REALM } from "../proxy/controller";
import { Resources } from "../proxy/resources";
import { fetchDocument, isPrimeUrl, prepareHtml, primeFrame, writeDocument } from "../proxy/document";
import { icons } from "./icons";
import { DevTools } from "./devtools";
import { renderNewTab } from "./newtab";

export const SEARCH_ENGINES: Record<string, { name: string; url: string }> = {
	duckduckgo: { name: "DuckDuckGo", url: "https://duckduckgo.com/?q=%s" },
	"duckduckgo-html": { name: "DuckDuckGo (HTML)", url: "https://html.duckduckgo.com/html/?q=%s" },
	brave: { name: "Brave Search", url: "https://search.brave.com/search?q=%s" },
	bing: { name: "Bing", url: "https://www.bing.com/search?q=%s" },
	google: { name: "Google", url: "https://www.google.com/search?q=%s" },
};

const NEWTAB = "about:newtab";
/** Bookmarks bar entries, e.g. `{ name: "Mail", url: "https://...", icon: icons.mail }`. Hidden when empty. */
const BOOKMARKS: Array<{ name: string; url: string; icon: string }> = [];
/** How long Esc must be held to leave fullscreen when we have to detect it ourselves. */
const ESC_HOLD_MS = 1000;
const FRAME_ALLOW = [
	"fullscreen",
	"autoplay",
	"clipboard-read",
	"clipboard-write",
	"encrypted-media",
	"gamepad",
	"picture-in-picture",
	"screen-wake-lock",
	"accelerometer",
	"gyroscope",
	"magnetometer",
	"midi",
	"xr-spatial-tracking",
].join("; ");

const store = {
	get(key: string, fallback: string) {
		try {
			return localStorage.getItem("sjl:" + key) ?? fallback;
		} catch {
			return fallback;
		}
	},
	set(key: string, value: string) {
		try {
			localStorage.setItem("sjl:" + key, value);
		} catch {}
	},
};

function h<K extends keyof HTMLElementTagNameMap>(tag: K, cls?: string, html?: string) {
	const el = document.createElement(tag);
	if (cls) el.className = cls;
	if (html !== undefined) el.innerHTML = html;
	return el;
}

let tabCounter = 0;

class Tab implements TabHost {
	id = "t" + ++tabCounter;
	clientId = "tab-" + Math.random().toString(36).slice(2, 10);
	frameName = "sjl-tab-" + this.id;
	resources: Resources;
	url = NEWTAB;
	title = "New Tab";
	icon: string | null = null;
	loading = false;
	error: { url: string; message: string } | null = null;

	stripEl: HTMLElement;
	pane: HTMLElement;
	frame: HTMLIFrameElement | null = null;
	/** set when a page window.open()ed this tab; re-applied to every new document */
	openerWin: Window | null = null;
	private navToken = 0;
	/** a navigation is fetching its document; the page on screen is on its way out */
	private navigating = false;
	private entries: string[] = [];
	private index = -1;
	// same-document entries the current page pushed, around our own position in them, and
	// the urls of the entries behind and ahead of us
	private spaBack = 0;
	private spaForward = 0;
	private spaBackUrls: string[] = [];
	private spaForwardUrls: string[] = [];
	/** bumped whenever the page reports a url change (a traversal shows up as one) */
	private urlReports = 0;

	constructor(private browser: Browser, private ctrl: Controller) {
		this.resources = new Resources(ctrl);
		this.pane = h("div", "pane");
		this.stripEl = h("div", "tab");
		this.stripEl.setAttribute("role", "tab");
		this.stripEl.innerHTML = `<span class="tab-icon"></span><span class="tab-title"></span><button class="tab-close" title="Close tab">${icons.close}</button>`;
		this.stripEl.addEventListener("mousedown", (e) => {
			if (e.button === 1) {
				e.preventDefault();
				browser.closeTab(this);
			} else if (e.button === 0 && !(e.target as Element).closest(".tab-close")) browser.activate(this);
		});
		this.stripEl.querySelector(".tab-close")!.addEventListener("click", (e) => {
			e.stopPropagation();
			browser.closeTab(this);
		});
		this.render();
	}

	// ---- TabHost ----

	navigate(url: string, init: NavInit = {}) {
		this.load(url, init, init.replace || init.reload ? "replace" : "push");
	}

	topWindow() {
		return this.frame?.contentWindow ?? null;
	}

	open(url: string | null, opts: { background?: boolean; opener?: Window; name?: string } = {}) {
		const tab = this.browser.newTab(null, { background: !!opts.background, after: this });
		tab.openerWin = opts.opener ?? null;
		// window.open(url, "name"): the tab's window has that name (for the page too), and
		// later lookups by it find this tab
		if (opts.name) tab.frameName = opts.name;
		const win = tab.pristineWindow();
		if (url) tab.navigate(url);
		else {
			// about:blank popup the opener will document.write() into
			tab.revealFrame();
			tab.setDisplay("about:blank", "about:blank");
		}
		return win;
	}

	loaded() {
		// a late report from the page being replaced (its 4s fallback timer, say)
		if (this.navigating) return;
		if (this.loading) this.setLoading(false);
		this.finishRetiring();
	}

	historyPushed() {
		this.spaBack++;
		this.spaForward = 0;
		// (called before the push's urlChanged, so this is the url being left)
		this.spaBackUrls.push(this.url);
		this.spaForwardUrls = [];
	}

	urlChanged(realUrl: string) {
		this.urlReports++;
		if (this.index >= 0) this.entries[this.index] = realUrl;
		this.url = realUrl;
		this.render();
		this.browser.tabUpdated(this);
	}

	titleChanged(title: string) {
		this.title = title.trim() || this.hostLabel();
		this.render();
		this.browser.tabUpdated(this);
	}

	iconChanged(url: string | null) {
		this.icon = url;
		this.render();
	}

	shortcut(e: { key: string; ctrl: boolean; alt: boolean; shift: boolean }) {
		return this.browser.shortcut(e);
	}

	// ---- frames ----

	private makeFrame() {
		const f = document.createElement("iframe");
		f.name = this.frameName;
		f.setAttribute("allow", FRAME_ALLOW);
		f.className = "frame";
		f.addEventListener("load", () => this.onFrameLoad(f));
		this.pane.append(f);
		return f;
	}

	/** The tab's window right now (window.open() hands this to the opener). */
	pristineWindow(): Window {
		this.frame ??= this.makeFrame();
		const win = this.frame.contentWindow!;
		this.ctrl.adopt(win, this, { isTabTop: true, clientId: this.clientId });
		return win;
	}

	/** One iframe per tab for its whole life, so WindowProxy references stay valid. */
	private async freshWindow(): Promise<any> {
		this.frame ??= this.makeFrame();
		this.ctrl.release(this.frame.contentWindow);
		return primeFrame(this.frame);
	}

	/** The document is gone from the pane (new tab page, error page): free what it held. */
	private dropDocument() {
		if (this.frame) this.ctrl.release(this.frame.contentWindow);
		this.finishRetiring();
		this.resources.clear();
		this.resources = new Resources(this.ctrl);
	}

	/** the previous document's resources, still lendable while the new one loads */
	private retiring: { res: Resources; timer: any } | null = null;

	/** A new document is going in: its resources become the tab's; the old ones go soon. */
	private adoptResources(next: Resources) {
		this.finishRetiring();
		const old = this.resources;
		this.resources = next;
		if (old === next) return;
		// nothing displays the old document any more, but the new one's lazy loads (images,
		// icons, frames) can still borrow from it until it has loaded
		this.retiring = { res: old, timer: setTimeout(() => this.finishRetiring(), 15_000) };
	}

	private finishRetiring() {
		if (!this.retiring) return;
		clearTimeout(this.retiring.timer);
		this.resources.detach();
		this.retiring.res.clear();
		this.retiring = null;
	}

	private onFrameLoad(f: HTMLIFrameElement) {
		if (f !== this.frame) return;
		const win: any = f.contentWindow;
		let href = "";
		try {
			href = win.location.href;
		} catch {
			// an image/pdf/text blob we showed, which is cross-origin at an opaque origin
			if (!this.navigating) this.setLoading(false);
			return;
		}
		if (isPrimeUrl(href)) return;
		const written = Object.prototype.hasOwnProperty.call(win, REALM) && win[REALM].written;
		if (!written && this.ctrl.isVirtual(href)) {
			// a navigation escaped interception and hit our host. recover.
			this.load(href, {}, "push");
			return;
		}
		// our own documents, or a blob the browser shows by itself (image, pdf, text)
		if ((written || href.startsWith("blob:")) && !this.navigating) this.setLoading(false);
	}

	// ---- navigation ----

	/** url: a real url, or a virtual one coming from inside a page */
	async load(url: string, init: NavInit = {}, mode: "push" | "replace" | "none" = "push") {
		if (url === NEWTAB || url === "about:blank" || url === "") {
			this.navToken++;
			this.navigating = false;
			this.showNewTab();
			this.commit(NEWTAB, mode);
			return;
		}
		const virtual = this.ctrl.isVirtual(url) ? url : this.ctrl.virtualFor(url);
		const real = this.ctrl.unrewrite(virtual);
		const token = ++this.navToken;
		this.navigating = true;
		const settled = () => token === this.navToken && (this.navigating = false);
		this.error = null;
		this.setDisplay(real, this.title);
		this.setLoading(true);

		// the new document gets its own blob cache, borrowing whatever it can from the current
		// one (same-site pages share scripts, styles, images). the current page keeps using its
		// own until the new one replaces it
		const next = new Resources(this.ctrl, this.resources);
		const abandon = () => next.clear();

		try {
			const fetched = await fetchDocument(this.ctrl, this, virtual, init);
			if (fetched.kind === "other") next.own(fetched.blobUrl);
			if (token !== this.navToken) return abandon();
			if (fetched.kind === "download") {
				settled();
				abandon();
				this.setLoading(false);
				this.setDisplay(this.url, this.title);
				return;
			}
			const finalReal = this.ctrl.unrewrite(fetched.url);
			if (fetched.kind === "other") {
				settled();
				this.frame ??= this.makeFrame();
				this.ctrl.release(this.frame.contentWindow);
				this.frame.contentWindow!.location.replace(fetched.blobUrl);
				this.icon = null;
				this.title = decodeURIComponent(new URL(finalReal).pathname.split("/").pop() || finalReal);
				this.adoptResources(next);
			} else {
				const html = await prepareHtml(this.ctrl, next, fetched.html, {
					clientUrl: fetched.url,
					clientId: this.clientId,
				});
				if (token !== this.navToken) return abandon();
				const win = await this.freshWindow();
				if (token !== this.navToken) return abandon();
				settled();
				this.icon = null;
				this.title = this.hostLabel(finalReal);
				if (this.openerWin) Object.defineProperty(win, "opener", { value: this.openerWin, writable: true, configurable: true });
				// commit first: the new document reports its url while being written
				this.commit(finalReal, mode);
				// and it resolves its resources while being written, so they must be in place
				this.adoptResources(next);
				writeDocument(this.ctrl, this, win, fetched.url, html, {
					initHeaders: fetched.headers,
					history: this.ctrl.handler.trackedClients.get(this.clientId)?.history ?? [],
					isTabTop: true,
					clientId: this.clientId,
					beforeWrite: (w) => this.browser.devtools.beforeWrite(this, w),
				});
				this.browser.devtools.documentWritten(this, win);
			}
			this.showFrame();
			if (fetched.kind === "other") this.commit(finalReal, mode);
		} catch (e: any) {
			abandon();
			if (token !== this.navToken) return;
			settled();
			console.error("[sjl] navigation failed", real, e);
			this.showError(real, e?.message || String(e));
		}
	}

	private commit(realUrl: string, mode: "push" | "replace" | "none") {
		this.spaBack = this.spaForward = 0;
		this.spaBackUrls = [];
		this.spaForwardUrls = [];
		if (mode === "push") {
			this.entries.splice(this.index + 1, Infinity, realUrl);
			this.index = this.entries.length - 1;
		} else if (mode === "replace") {
			if (this.index < 0) this.index = 0;
			this.entries[this.index] = realUrl;
		}
		this.url = realUrl;
		this.render();
		this.browser.tabUpdated(this);
	}

	get canGoBack() {
		return this.spaBack > 0 || this.index > 0;
	}
	get canGoForward() {
		return this.spaForward > 0 || this.index < this.entries.length - 1;
	}

	/**
	 * Step through the page's own (pushState) entries. Some windows can't traverse their
	 * session history (an about:blank window its opener wrote this app into); if the page
	 * reports no url change, load the url that entry had instead.
	 */
	private traverse(delta: -1 | 1) {
		const win = this.frame!.contentWindow!;
		const [from, to] = delta < 0 ? [this.spaBackUrls, this.spaForwardUrls] : [this.spaForwardUrls, this.spaBackUrls];
		const target = from.pop();
		to.push(this.url);
		if (delta < 0) this.spaBack--, this.spaForward++;
		else this.spaForward--, this.spaBack++;
		const reports = this.urlReports;
		const token = this.navToken;
		try {
			win.history.go(delta);
		} catch {}
		setTimeout(() => {
			if (this.urlReports === reports && this.navToken === token && target && target !== this.url)
				this.load(target, {}, "replace");
		}, 300);
	}

	back() {
		if (this.url !== NEWTAB && this.spaBack > 0 && this.frame?.contentWindow) return this.traverse(-1);
		if (this.index > 0) {
			this.index--;
			this.load(this.entries[this.index], {}, "none");
		}
	}

	forward() {
		if (this.url !== NEWTAB && this.spaForward > 0 && this.frame?.contentWindow) return this.traverse(1);
		if (this.index < this.entries.length - 1) {
			this.index++;
			this.load(this.entries[this.index], {}, "none");
		}
	}

	reload() {
		if (this.url === NEWTAB) return;
		this.load(this.error?.url ?? this.url, {}, "replace");
	}

	stop() {
		this.navToken++;
		this.navigating = false;
		try {
			this.frame?.contentWindow?.stop();
		} catch {}
		this.setLoading(false);
		this.setDisplay(this.url, this.title);
	}

	// ---- display ----

	hostLabel(url = this.url) {
		try {
			return new URL(url).hostname || url;
		} catch {
			return url;
		}
	}

	setDisplay(url: string, title: string) {
		this.url = url;
		this.title = title;
		this.render();
		this.browser.tabUpdated(this);
	}

	setLoading(v: boolean) {
		this.loading = v;
		this.render();
		this.browser.tabUpdated(this);
	}

	private clearPane(keepFrame: boolean) {
		for (const el of [...this.pane.children]) {
			if (keepFrame && el === this.frame) continue;
			el.remove();
		}
		if (!keepFrame) this.frame = null;
	}

	showNewTab() {
		this.dropDocument();
		this.clearPane(false);
		this.error = null;
		this.loading = false;
		this.title = "New Tab";
		this.icon = null;
		this.pane.append(renderNewTab((q) => this.browser.go(q, this), this.browser.engine.name));
		this.render();
		this.browser.tabUpdated(this);
	}

	private showFrame() {
		this.clearPane(true);
	}

	revealFrame() {
		this.clearPane(true);
	}

	private showError(url: string, message: string) {
		this.error = { url, message };
		this.loading = false;
		this.dropDocument();
		this.clearPane(false);
		const box = h("div", "error-page");
		box.innerHTML = `
			<div class="error-inner">
				<div class="error-icon">${icons.warning}</div>
				<h1>This page couldn't be loaded</h1>
				<p class="error-url"></p>
				<p class="error-msg"></p>
				<p class="error-hint">Check that your wisp server is reachable (menu → Settings) and that the address is right.</p>
				<button class="btn primary">Try again</button>
			</div>`;
		box.querySelector(".error-url")!.textContent = url;
		box.querySelector(".error-msg")!.textContent = message;
		box.querySelector("button")!.addEventListener("click", () => this.load(url, {}, "replace"));
		this.pane.append(box);
		this.title = this.hostLabel(url);
		this.url = url;
		this.render();
		this.browser.tabUpdated(this);
	}

	render() {
		const iconEl = this.stripEl.querySelector(".tab-icon")!;
		if (this.loading) iconEl.innerHTML = `<span class="spinner"></span>`;
		else if (this.icon) {
			iconEl.innerHTML = "";
			const img = document.createElement("img");
			img.src = this.icon;
			img.alt = "";
			img.onerror = () => (iconEl.innerHTML = icons.globe);
			iconEl.append(img);
		} else iconEl.innerHTML = this.url === NEWTAB ? "" : icons.globe;
		this.stripEl.querySelector(".tab-title")!.textContent = this.title;
		this.stripEl.title = this.title;
	}

	destroy() {
		this.navToken++;
		if (this.frame) this.ctrl.release(this.frame.contentWindow);
		this.pane.remove();
		this.stripEl.remove();
		this.finishRetiring();
		this.resources.clear();
		this.ctrl.forgetClient(this.clientId);
		this.openerWin = null;
	}
}

export class Browser {
	tabs: Tab[] = [];
	active: Tab | null = null;
	engineKey = store.get("engine", "duckduckgo");
	devtools: DevTools;

	private root: HTMLElement;
	private strip: HTMLElement;
	private newTabBtn: HTMLButtonElement;
	private omnibox: HTMLInputElement;
	private omniIcon: HTMLElement;
	private viewport: HTMLElement;
	private progress: HTMLElement;
	private btn: Record<string, HTMLButtonElement> = {};
	private menu: HTMLElement;
	private statusDot: HTMLElement;
	private fsHint: HTMLElement;
	private fsHintTimer: any = null;
	private escDownAt = 0;
	private status: { state: string; detail?: string } = { state: "connecting" };

	get engine() {
		return SEARCH_ENGINES[this.engineKey] ?? SEARCH_ENGINES.duckduckgo;
	}

	constructor(private ctrl: Controller, mount: HTMLElement) {
		ctrl.tabs = () => this.tabs;
		this.root = mount;
		this.root.className = "browser";
		this.root.innerHTML = `
			<header class="chrome">
				<div class="tabstrip" role="tablist">
					<div class="tabs"></div>
					<button class="icon-btn newtab-btn" title="New tab (Alt+T)">${icons.plus}</button>
				</div>
				<div class="toolbar">
					<button class="icon-btn" data-act="back" title="Back (Alt+Left)">${icons.back}</button>
					<button class="icon-btn" data-act="forward" title="Forward (Alt+Right)">${icons.forward}</button>
					<button class="icon-btn" data-act="reload" title="Reload (Ctrl+R)">${icons.reload}</button>
					<button class="icon-btn" data-act="home" title="Home">${icons.home}</button>
					<form class="omnibox" autocomplete="off">
						<span class="omni-icon"></span>
						<input type="text" spellcheck="false" aria-label="Address and search bar" />
					</form>
					<button class="icon-btn" data-act="devtools" title="Developer tools (F12)" aria-pressed="false">${icons.code}</button>
					<button class="icon-btn" data-act="fullscreen" title="Fullscreen">${icons.fullscreen}</button>
					<button class="icon-btn menu-btn" data-act="menu" title="Menu">${icons.menu}<span class="status-dot"></span></button>
				</div>
				<nav class="bookmarks" aria-label="Bookmarks"></nav>
				<div class="progress"><div></div></div>
			</header>
			<main class="viewport">
				<div class="fs-hint" hidden>Press and hold <kbd>Esc</kbd> to exit full screen</div>
			</main>
			<div class="menu" hidden></div>`;
		this.strip = this.root.querySelector(".tabs")!;
		this.newTabBtn = this.root.querySelector(".newtab-btn")!;
		this.omnibox = this.root.querySelector(".omnibox input")!;
		this.omniIcon = this.root.querySelector(".omni-icon")!;
		this.viewport = this.root.querySelector(".viewport")!;
		this.progress = this.root.querySelector(".progress")!;
		this.menu = this.root.querySelector(".menu")!;
		this.statusDot = this.root.querySelector(".status-dot")!;
		this.fsHint = this.root.querySelector(".fs-hint")!;
		this.renderBookmarks();
		// Chrome exits fullscreen on a single Esc press, and pages can't cancel that. With a
		// keyboard lock on Escape, Chrome instead requires Esc to be held, and short presses
		// reach the page (a game's pause menu). The lock only applies while the page is
		// fullscreen, so requesting it up front also covers games' own fullscreen buttons.
		this.lockEscape();
		for (const b of this.root.querySelectorAll<HTMLButtonElement>("[data-act]")) this.btn[b.dataset.act!] = b;

		this.newTabBtn.addEventListener("click", () => this.newTab(null));
		this.btn.back.addEventListener("click", () => this.active?.back());
		this.btn.forward.addEventListener("click", () => this.active?.forward());
		this.btn.reload.addEventListener("click", () => (this.active?.loading ? this.active.stop() : this.active?.reload()));
		this.btn.home.addEventListener("click", () => this.active?.load(NEWTAB));
		this.btn.fullscreen.addEventListener("click", () => this.toggleFullscreen());
		this.devtools = new DevTools(ctrl);
		this.devtools.onchange = (tab) => this.tabUpdated(tab as Tab);
		this.btn.devtools.addEventListener("click", () => this.active && this.devtools.toggle(this.active));
		this.btn.menu.addEventListener("click", (e) => {
			e.stopPropagation();
			this.toggleMenu();
		});
		document.addEventListener("fullscreenchange", () => this.syncFullscreen());
		document.addEventListener("click", (e) => {
			if (!this.menu.hidden && !this.menu.contains(e.target as Node)) this.menu.hidden = true;
		});

		this.root.querySelector(".omnibox")!.addEventListener("submit", (e) => {
			e.preventDefault();
			if (this.active && this.omnibox.value.trim()) {
				this.go(this.omnibox.value, this.active);
				this.omnibox.blur();
			}
		});
		this.omnibox.addEventListener("focus", () => requestAnimationFrame(() => this.omnibox.select()));
		this.omnibox.addEventListener("keydown", (e) => {
			if (e.key === "Escape") {
				this.omnibox.value = this.displayUrl(this.active);
				this.omnibox.blur();
			}
		});
		this.omnibox.addEventListener("blur", () => (this.omnibox.value = this.displayUrl(this.active)));

		window.addEventListener("keydown", (e) => {
			const handled = this.shortcut({
				key: e.key,
				ctrl: e.ctrlKey || e.metaKey,
				alt: e.altKey,
				shift: e.shiftKey,
				meta: e.metaKey,
				repeat: e.repeat,
			});
			if (handled) e.preventDefault();
		});

		ctrl.transport.onstatus = (state, detail) => {
			this.status = { state, detail };
			this.statusDot.dataset.state = state;
			this.statusDot.title = state === "ready" ? "Connected to wisp server" : state === "error" ? "Wisp connection failed" : "Connecting…";
		};
		this.statusDot.dataset.state = ctrl.transport.ready ? "ready" : "connecting";
		// nothing to connect to yet: ask for a server first thing
		if (!ctrl.transport.wispUrl) {
			this.status = { state: "error", detail: "no wisp server set" };
			this.statusDot.dataset.state = "error";
			requestAnimationFrame(() => this.menu.hidden && this.toggleMenu());
		}
	}

	// ---- bookmarks ----

	private renderBookmarks() {
		const bar = this.root.querySelector<HTMLElement>(".bookmarks")!;
		bar.hidden = !BOOKMARKS.length;
		for (const bm of BOOKMARKS) {
			const b = h("button", "bookmark");
			b.title = bm.url;
			b.innerHTML = `<span class="bm-icon">${bm.icon}</span><span class="bm-name"></span>`;
			b.querySelector(".bm-name")!.textContent = bm.name;
			// click: this tab. middle or ctrl/cmd click: new background tab, like any browser
			b.addEventListener("click", (e) => {
				if (e.ctrlKey || e.metaKey) this.newTab(bm.url, { background: true, after: this.active ?? undefined });
				else if (this.active) this.active.load(bm.url);
				else this.newTab(bm.url);
			});
			b.addEventListener("auxclick", (e) => {
				if (e.button === 1) this.newTab(bm.url, { background: true, after: this.active ?? undefined });
			});
			b.addEventListener("mousedown", (e) => e.button === 1 && e.preventDefault());
			bar.append(b);
		}
	}

	// ---- tabs ----

	newTab(url: string | null, opts: { background?: boolean; after?: Tab } = {}) {
		const tab = new Tab(this, this.ctrl);
		const idx = opts.after ? this.tabs.indexOf(opts.after) + 1 : this.tabs.length;
		this.tabs.splice(idx, 0, tab);
		const before = this.tabs[idx + 1]?.stripEl ?? null;
		this.strip.insertBefore(tab.stripEl, before);
		this.viewport.append(tab.pane);
		if (url) tab.load(url);
		else tab.showNewTab();
		if (!opts.background || !this.active) this.activate(tab);
		if (!url && !opts.background) requestAnimationFrame(() => this.focusStart(tab));
		return tab;
	}

	private focusStart(tab: Tab) {
		const input = tab.pane.querySelector<HTMLInputElement>(".newtab input");
		(input ?? this.omnibox).focus();
	}

	activate(tab: Tab) {
		this.active = tab;
		for (const t of this.tabs) {
			const on = t === tab;
			t.stripEl.classList.toggle("active", on);
			t.stripEl.setAttribute("aria-selected", String(on));
			t.pane.classList.toggle("active", on);
		}
		tab.stripEl.scrollIntoView({ block: "nearest", inline: "nearest" });
		this.tabUpdated(tab);
	}

	closeTab(tab: Tab) {
		const i = this.tabs.indexOf(tab);
		if (i === -1) return;
		this.tabs.splice(i, 1);
		tab.destroy();
		if (!this.tabs.length) {
			this.newTab(null);
			return;
		}
		if (this.active === tab) this.activate(this.tabs[Math.min(i, this.tabs.length - 1)]);
	}

	tabUpdated(tab: Tab) {
		if (tab !== this.active) return;
		if (document.activeElement !== this.omnibox) this.omnibox.value = this.displayUrl(tab);
		let secure = false;
		try {
			secure = new URL(tab.url).protocol === "https:";
		} catch {}
		this.omniIcon.innerHTML = tab.url === NEWTAB ? icons.search : secure ? icons.lock : icons.unlocked;
		this.omniIcon.title = tab.url === NEWTAB ? "" : secure ? "Connection is encrypted end to end (TLS over wisp)" : "Not secure";
		this.btn.back.disabled = !tab.canGoBack;
		this.btn.forward.disabled = !tab.canGoForward;
		this.btn.reload.innerHTML = tab.loading ? icons.stop : icons.reload;
		this.btn.reload.title = tab.loading ? "Stop" : "Reload (Ctrl+R)";
		this.progress.classList.toggle("on", tab.loading);
		const dt = this.devtools.isOpen(tab);
		this.btn.devtools.classList.toggle("on", dt);
		this.btn.devtools.setAttribute("aria-pressed", String(dt));
	}

	private displayUrl(tab: Tab | null) {
		if (!tab || tab.url === NEWTAB || tab.url === "about:blank") return "";
		return tab.url;
	}

	/** Omnibox / new tab page input: a url, or a search. */
	go(input: string, tab: Tab) {
		tab.load(this.toUrl(input));
	}

	toUrl(input: string) {
		const s = input.trim();
		if (/^about:(newtab|blank)$/i.test(s)) return NEWTAB;
		if (/^https?:\/\//i.test(s)) return s;
		if (/^(localhost|\d{1,3}(\.\d{1,3}){3})(:\d+)?(\/|$)/i.test(s)) return "http://" + s;
		if (!/\s/.test(s) && /^[^\s/?#]+\.[a-z][a-z0-9-]{1,62}\.?(:\d+)?([/?#].*)?$/i.test(s)) return "https://" + s;
		return this.engine.url.replace("%s", encodeURIComponent(s));
	}

	shortcut(e: { key: string; ctrl: boolean; alt: boolean; shift: boolean; meta?: boolean; repeat?: boolean }) {
		const k = e.key.toLowerCase();
		const tab = this.active;
		if ((e.alt && k === "t") || (e.ctrl && !e.shift && k === "t")) return this.newTab(null), true;
		if ((e.alt && k === "w") || (e.ctrl && k === "w")) return tab && this.closeTab(tab), true;
		if (e.ctrl && k === "l") return this.omnibox.focus(), true;
		if ((e.ctrl && k === "r") || k === "f5") return tab?.reload(), true;
		if (k === "escape" && this.root.classList.contains("pseudo-fs")) {
			// fallback fullscreen (the real one was refused): the browser won't do the
			// hold-to-exit for us, so time it. Key repeat only fires while the key is held,
			// so no keyup is needed; the page still gets every press.
			const now = performance.now();
			if (!e.repeat) this.escDownAt = now;
			else if (this.escDownAt && now - this.escDownAt >= ESC_HOLD_MS) {
				this.escDownAt = 0;
				this.toggleFullscreen(false);
				return true;
			}
			return false;
		}
		if (tab && (k === "f12" || (e.ctrl && e.shift && k === "i"))) return this.devtools.toggle(tab), true;
		if (tab && e.ctrl && e.shift && k === "j") return this.devtools.show(tab, "console"), true;
		if (tab && e.ctrl && e.shift && k === "c") return this.devtools.show(tab, "elements"), true;
		if (e.alt && k === "arrowleft") return tab?.back(), true;
		if (e.alt && k === "arrowright") return tab?.forward(), true;
		return false;
	}

	// ---- fullscreen ----

	private lockEscape() {
		const kb = (navigator as any).keyboard;
		// only allowed in a top-level, secure page (https, localhost, or a blob of those)
		kb?.lock?.(["Escape"]).catch(() => {});
	}

	private showFsHint() {
		this.fsHint.hidden = false;
		clearTimeout(this.fsHintTimer);
		this.fsHintTimer = setTimeout(() => (this.fsHint.hidden = true), 3500);
	}

	toggleFullscreen(force?: boolean) {
		const on = force ?? !(document.fullscreenElement || this.root.classList.contains("pseudo-fs"));
		if (on) {
			this.lockEscape();
			const enter = this.root.requestFullscreen?.({ navigationUI: "hide" });
			(enter ?? Promise.reject()).catch(() => {
				this.root.classList.add("pseudo-fs");
				this.syncFullscreen();
				this.showFsHint();
			});
			// with the lock active Chrome shows its own "hold Esc" bubble; elsewhere
			// (no Keyboard Lock support) Esc exits immediately, so no hint then
		} else {
			if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
			this.root.classList.remove("fs", "pseudo-fs");
		}
		this.syncFullscreen();
	}

	private syncFullscreen() {
		// called right after requesting fullscreen (still pending) and again on
		// fullscreenchange; only the real state decides whether the chrome is hidden
		const fs = document.fullscreenElement === this.root || this.root.classList.contains("pseudo-fs");
		this.root.classList.toggle("fs", fs);
		this.btn.fullscreen.innerHTML = fs ? icons.exitFullscreen : icons.fullscreen;
		this.btn.fullscreen.title = fs ? "Exit fullscreen (or hold Esc)" : "Fullscreen";
	}

	// ---- menu / settings ----

	private toggleMenu() {
		if (!this.menu.hidden) {
			this.menu.hidden = true;
			return;
		}
		const st = this.status;
		this.menu.innerHTML = `
			<section>
				<h2>Settings</h2>
				<label class="field">
					<span>Wisp server</span>
					<input name="wisp" type="text" spellcheck="false" />
				</label>
				<div class="conn"><span class="status-dot" data-state="${st.state}"></span><span class="conn-text"></span></div>
				<label class="check">
					<input name="wispx" type="checkbox" />
					<span>Use WispX <small>(faster; falls back to Wisp v1 on servers without it)</small></span>
				</label>
				<label class="field">
					<span>Search engine</span>
					<select name="engine">${Object.entries(SEARCH_ENGINES)
						.map(([k, v]) => `<option value="${k}" ${k === this.engineKey ? "selected" : ""}>${v.name}</option>`)
						.join("")}</select>
				</label>
				<div class="row">
					<button class="btn primary" data-m="save">Save</button>
					${DEFAULT_WISP ? `<button class="btn" data-m="reset">Default server</button>` : ""}
				</div>
			</section>
			<section>
				<button class="menu-item" data-m="devtools">${icons.code}<span>Developer tools</span><kbd>F12</kbd></button>
				<button class="menu-item" data-m="cookies">${icons.trash}<span>Clear cookies &amp; site data</span></button>
				<button class="menu-item" data-m="about">${icons.info}<span>How this works</span></button>
			</section>`;
		const t = this.ctrl.transport;
		const wisp = this.menu.querySelector<HTMLInputElement>('input[name="wisp"]')!;
		wisp.value = t.wispUrl;
		const wispx = this.menu.querySelector<HTMLInputElement>('input[name="wispx"]')!;
		wispx.checked = t.wispx;
		this.menu.querySelector(".conn-text")!.textContent =
			st.state === "ready"
				? `Connected (${t.protocolLabel})`
				: st.state === "error"
					? "Couldn't connect" + (st.detail ? `: ${st.detail}` : "")
					: "Connecting…";
		const engine = this.menu.querySelector<HTMLSelectElement>('select[name="engine"]')!;
		this.menu.querySelector('[data-m="save"]')!.addEventListener("click", () => {
			this.engineKey = engine.value;
			store.set("engine", engine.value);
			const url = wisp.value.trim();
			if (url && (url !== t.wispUrl || wispx.checked !== t.wispx)) {
				store.set("wisp", url);
				store.set("wispx", wispx.checked ? "1" : "0");
				t.setWisp(url, wispx.checked).catch(() => {});
			}
			this.menu.hidden = true;
		});
		this.menu.querySelector('[data-m="reset"]')?.addEventListener("click", () => {
			wisp.value = DEFAULT_WISP;
		});
		this.menu.querySelector('[data-m="cookies"]')!.addEventListener("click", () => {
			this.ctrl.clearCookies();
			try {
				for (const k of Object.keys(localStorage)) if (!k.startsWith("sjl:")) localStorage.removeItem(k);
			} catch {}
			this.menu.hidden = true;
			this.active?.reload();
		});
		this.menu.querySelector('[data-m="devtools"]')!.addEventListener("click", () => {
			this.menu.hidden = true;
			if (this.active) this.devtools.toggle(this.active);
		});
		this.menu.querySelector('[data-m="about"]')!.addEventListener("click", () => {
			this.menu.hidden = true;
			this.showAbout();
		});
		this.menu.hidden = false;
	}

	private showAbout() {
		const dlg = h("dialog", "about");
		dlg.innerHTML = `
			<h2>Service-worker-less Scramjet</h2>
			<p>Normally Scramjet needs a service worker to catch the requests a page makes and send them through wisp. This build has none. Every site runs in a same-origin frame, and the requests a service worker would have caught are answered in the page itself:</p>
			<ul>
				<li><b>fetch, XHR, WebSocket, EventSource</b> go straight to the wisp transport (TLS is done in the browser by epoxy).</li>
				<li><b>Scripts, stylesheets, images, fonts, and ES module graphs</b> are fetched through wisp and handed to the page as <code>blob:</code> URLs.</li>
				<li><b>Navigation</b> is intercepted and replaced by a fetch, a rewrite, and a write into a fresh frame, so this page's own URL never changes.</li>
			</ul>
			<p>WebGL, WebGPU, WebAssembly, and audio run on the real browser with no emulation layer in between.</p>
			<form method="dialog"><button class="btn primary">OK</button></form>`;
		document.body.append(dlg);
		dlg.addEventListener("close", () => dlg.remove());
		dlg.showModal();
	}
}

/** None built in; `VITE_DEFAULT_WISP=wss://your.server/ npm run build` bakes one in */
export const DEFAULT_WISP: string = import.meta.env.VITE_DEFAULT_WISP || "";

/**
 * Settings handed in from outside, which also work where localStorage doesn't (opaque
 * origins): a `wisp` / `wispx` parameter in the url's query or fragment
 * (`index.html#wisp=wss://host/`), or `window.SJL_CONFIG = { wisp, wispx }` set by a launcher
 * before this script runs. A url parameter is also saved, where saving works.
 */
function launchSetting(name: "wisp" | "wispx"): string | null {
	for (const part of [location.search.slice(1), location.hash.slice(1)]) {
		const v = new URLSearchParams(part).get(name);
		if (v) {
			store.set(name, v);
			return v;
		}
	}
	const v = (globalThis as any).SJL_CONFIG?.[name];
	return v === undefined || v === null ? null : String(v);
}

export const savedWisp = () => launchSetting("wisp") ?? store.get("wisp", DEFAULT_WISP);
export const savedWispx = () => !/^(0|false|off|no)$/i.test(launchSetting("wispx") ?? store.get("wispx", "1"));
