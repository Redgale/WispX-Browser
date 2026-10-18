import "./ui/styles.css";
import { Controller } from "./proxy/controller";
import { canScriptChildFrames, detectFrameMode } from "./proxy/env";
import { Browser, savedWisp, savedWispx } from "./ui/browser";

const mount = document.getElementById("app")!;
// this page's own source, before anything below changes the DOM (for relaunching it)
const source = "<!doctype html>" + document.documentElement.outerHTML;

function fail(message: string) {
	mount.className = "boot-error";
	mount.textContent = message;
}

/**
 * Inside a sandboxed frame without allow-same-origin, every frame gets an origin of its own,
 * so no page can be shown. A popup allowed to escape the sandbox isn't sandboxed: run there.
 */
function sandboxed() {
	fail(
		"This page is inside a sandboxed frame without allow-same-origin, where no page can be shown " +
			"(every frame gets an origin of its own). Open it in a tab or window of its own, or add " +
			"allow-same-origin to the frame's sandbox."
	);
	const btn = document.createElement("button");
	btn.className = "btn primary";
	btn.textContent = "Open in a new window";
	btn.addEventListener("click", () => {
		const w = window.open("", "_blank");
		if (!w) return void (btn.textContent = "Popups are blocked here");
		w.document.open();
		w.document.write(source);
		w.document.close();
	});
	mount.append(document.createElement("br"), btn);
}

if (!canScriptChildFrames()) sandboxed();
else {
	try {
		const [ctrl] = await Promise.all([Controller.create(savedWisp(), savedWispx()), detectFrameMode()]);
		const browser = new Browser(ctrl, mount);
		browser.newTab(null);
		Object.defineProperty(window, "__sjl", { value: { ctrl, browser }, enumerable: false });
	} catch (e) {
		console.error(e);
		fail("Failed to start: " + (e instanceof Error ? e.message : String(e)));
	}
}
