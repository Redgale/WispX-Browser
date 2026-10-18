// What kind of origin this app runs at. That decides how proxied documents get their frames.
//
// Served over http(s), or opened from a blob: url made by such a page, the app has a normal
// origin: frames it loads from its own blob: urls are same-origin with it, and the virtual
// /~/sj/ urls live on its own host.
//
// At an opaque ("null") origin (a data: url, a blob:null url, a file:, or about:blank written
// by such a page) every blob: document gets a fresh origin of its own, so frames are srcdoc
// documents instead (those inherit ours), and the virtual urls get a host of their own,
// since "null" can't carry a path. Chrome does the same to blob: documents of an about:blank
// window its opener wrote the app into, even at an http origin; detectFrameMode() finds out.

/** The origin part of this realm's blob: urls (blob:<origin>/<id>); "null" when opaque. */
export const BLOB_ORIGIN = (() => {
	const u = URL.createObjectURL(new Blob([]));
	URL.revokeObjectURL(u);
	return u.slice(5, u.lastIndexOf("/"));
})();

/** documents loaded from our own blob: urls wouldn't be same-origin with us (see detectFrameMode) */
export let SRCDOC_FRAMES = BLOB_ORIGIN === "null";

/** From now on, frames are srcdoc documents (a blob: one turned out cross-origin). */
export function useSrcdocFrames() {
	if (!SRCDOC_FRAMES) console.info("[sjl] blob: frames aren't same-origin here; using srcdoc frames");
	SRCDOC_FRAMES = true;
}

/** Load one of our blob: documents into a frame and see whether we can script it. */
export async function detectFrameMode() {
	if (SRCDOC_FRAMES) return;
	const f = document.createElement("iframe");
	f.style.display = "none";
	const url = URL.createObjectURL(new Blob(["<!doctype html>"], { type: "text/html" }));
	try {
		await new Promise<void>((resolve) => {
			f.addEventListener("load", () => resolve(), { once: true });
			setTimeout(resolve, 3000);
			f.src = url;
			document.documentElement.append(f);
		});
		try {
			void f.contentWindow!.document.documentElement;
		} catch {
			useSrcdocFrames();
		}
	} finally {
		f.remove();
		URL.revokeObjectURL(url);
	}
}

/** self.origin, not location.origin: about:blank written by an http page has that page's origin */
const HTTP_ORIGIN = /^https?:\/\//.test(self.origin) ? self.origin : null;

/** Where virtual urls live. `.invalid` never resolves, so a url that escapes goes nowhere. */
export const PREFIX = (HTTP_ORIGIN ?? "https://sjl.invalid") + "/~/sj/";

/**
 * A sandboxed frame without allow-same-origin gives every frame inside it a fresh origin,
 * even about:blank and srcdoc ones, so no proxied page could ever be scripted from here.
 */
export function canScriptChildFrames(): boolean {
	const f = document.createElement("iframe");
	f.style.display = "none";
	document.documentElement.append(f);
	try {
		return !!f.contentWindow!.document;
	} catch {
		return false;
	} finally {
		f.remove();
	}
}
