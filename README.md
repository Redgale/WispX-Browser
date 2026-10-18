# WispX Browser

A service-worker-less Scramjet browser that speaks WispX.


A browser-in-a-page built on Scramjet 2 (`2.0.67-alpha.2`) and wisp, with **no service worker**.
The whole thing builds to a single `dist/index.html` (~3.4 MB: UI, scramjet, its rewriter wasm,
and the epoxy TLS/wisp client are all inlined). It runs from a normal http(s) page, a `blob:` url,
an about:blank window, or a null origin (`data:`, `blob:null`, `file:`), and talks
[WispX](TODO-WISPX-PROTOCOL-URL/blob/main/protocolX.md) to servers that support it, such as
the WispX server in [WispX-Rust](TODO-WISPX-RUST-URL).

```sh
npm install
npm run dev       # http://localhost:5173
npm run build     # -> dist/index.html (host it anywhere over http/https)
npm run preview   # serve the built file on http://localhost:4173
```

No wisp server is built in: the app opens its settings (⋮ menu) on first start to ask for one, and
saves it in localStorage. `VITE_DEFAULT_WISP=wss://your.server/ npm run build` bakes in a default.
Default search engine: DuckDuckGo.

### Settings from outside

Where localStorage doesn't work (null origins) or a launcher wants to pick the server, the app also
takes its settings from:

- a `wisp` / `wispx` parameter in the url's query or fragment: `index.html#wisp=wss://host/&wispx=0`
  (also saved, where saving works);
- `window.SJL_CONFIG = { wisp: "wss://host/", wispx: true }`, set by a launcher before the app's
  script runs (e.g. a `<script>` written in front of it).

### Testing locally

```sh
npm run build
node tools/serve.mjs                  # app on http://localhost:4173/, launcher on /launch.html
# in a WispX-Rust checkout:
(cd WispX-Rust && CARGO_TARGET_DIR=/tmp/wispx-target cargo run --release -p epoxy-server)
                                      # wisp server on ws://localhost:4000/ (WispX)
```

`tools/launch.html` opens the app in every context it supports (normal page, `blob:`, about:blank
popup, inside a `data:` frame, a `blob:null` page, an about:blank popup at a null origin, and a
sandboxed frame).

## How it works

Stock Scramjet 2 already runs the real work (`ScramjetFetchHandler`) in the page; the service
worker only catches requests to `/~/sj/...` urls and forwards them over a MessagePort. This project
removes the service worker and answers those requests in the page itself:

| Where a request comes from | Stock Scramjet | Here |
| --- | --- | --- |
| `fetch`, `XMLHttpRequest`, `EventSource`, `sendBeacon` | SW | sink layer calls `Controller.serve()` directly and builds a real `Response` |
| `WebSocket` | transport | transport, through a per-realm wrapper that closes it with the page |
| `<script src>`, stylesheets, images, fonts, media | SW | fetched through wisp, handed to the element as a `blob:` url |
| ES module graphs (`import`, import maps, `import()`) | SW | whole graph linked up front, specifiers rewritten to blob urls |
| Workers / SharedWorkers | SW | bootstrapped from a blob; RPC back to the controller over a MessagePort |
| Navigations (links, forms, `location =`) | SW | caught via the Navigation API, fetched, rewritten, written into a fresh frame |

- `src/proxy/controller.ts`: replaces both the scramjet-controller and the SW. `serve()` is the
  SW's old fetch route; `adopt()` turns a same-origin frame into a proxied realm.
- `src/realm/sink.js`: runs inside every proxied window/worker *underneath* scramjet's hooks.
  Scramjet rewrites urls and then calls what it thinks are natives; these are the "natives".
- `src/proxy/resources.ts`: blob cache (one generation per document, borrowing from the
  previous one; blob urls are reference counted), CSS asset inlining, module graph linking.
- `src/proxy/runtime.ts`: the wisp transport (the epoxy client from `vendor/epoxy-tls`, WispX with
  fallback) and the patches applied to scramjet's source.
- `src/proxy/env.ts`: what kind of origin the app runs at, which decides how frames are made (see
  "Where it runs").
- `src/proxy/realm-net.ts`: everything a realm has open (WebSockets, streamed response bodies,
  worker ports). Closed on `pagehide` / when the tab replaces the document, so a page you left
  can't keep running socket handlers or downloading, or keep its JS heap alive.
- `src/proxy/document.ts`: document loading. Each frame is first pointed at a tiny `blob:`
  document (Chrome disables Navigation API events on `about:blank`), then `document.open()`,
  `history.replaceState()` to the virtual url where the browser allows it, write. Scramjet's
  `client.url` is overridden to read a per-frame tracked url, so it also works when the app
  itself runs from a `blob:` url (where that replaceState is refused).
- `src/ui/`: the browser chrome (tabs, omnibox, history, fullscreen, settings, devtools).

## Developer tools

F12 / Ctrl+Shift+I (or the `</>` toolbar button) docks [Eruda](https://eruda.liriliri.io/)
(console, elements, network, storage, sources) into the active tab's page. It runs in the
page's realm, and console input goes through scramjet's rewriter like the page's own code, so
`location.href` is the site's url. It stays open across that tab's navigations and replays the
console output of a new document from its first script. Ctrl+Shift+J opens the console,
Ctrl+Shift+C the elements panel.

For the proxy itself, the app's own console has `__sjl.ctrl.stats()` (open realms, sockets,
blobs, wisp retries/reconnects) and `__sjl.ctrl.openRealms()`.

## Wisp connection

One epoxy client multiplexes everything over a single wisp connection. It speaks
[WispX](TODO-WISPX-PROTOCOL-URL/blob/main/protocolX.md) (one round trip less per connection, many frames per websocket message,
real flow control both ways) with servers that support it, such as epoxy-server from [WispX-Rust](TODO-WISPX-RUST-URL).
Servers that don't get Wisp v2 or v1: an older epoxy-server answers like v2 and the client follows,
and a server that refuses the `wispx` subprotocol outright is detected (a plain websocket to it
works) and spoken to in Wisp v1. Settings → "Use WispX" turns it off; the settings panel shows the
protocol in use.

The connection is opened as soon as the app starts, while scramjet loads, so the first page doesn't
wait for the websocket and handshake. Requests that die on a recycled upstream connection are
retried; if the wisp connection itself drops (server restart, network change), it's replaced and
the requests retried with backoff for ~7s.

Measured in headless Chrome against the same epoxy-server through a 50 ms round-trip proxy (median
of 6 interleaved runs): the first page after startup loads in 157 ms instead of 200 ms (the
connection is already open), startup itself takes ~20 ms longer, and later pages take the same time
as before (each request still costs one round trip to the wisp server). On loopback both builds are
equal.

The client is built from `client/` in [WispX-Rust](TODO-WISPX-RUST-URL) (see `vendor/epoxy-tls/README.md`); it no longer
depends on the `@mercuryworkshop/epoxy-transport` package.

The top-level page never navigates, so its URL never changes.

## What runs natively

WebGL/WebGL2/WebGPU, WebAssembly (including `instantiateStreaming`), audio, video/MediaSource, and
workers all run on the real browser, with no emulation layer. Tested: three.js glTF + Draco
(ES modules + import map + WASM worker), YouTube playback, Wikipedia, DuckDuckGo, MDN worker demos.

## Known limitations

- **`document.write('<script src=...>')` during parsing** can't block the parser without a
  service worker, so those scripts run late (breaks some old sites, e.g. webglsamples' aquarium).
- **Synchronous XHR** to proxied urls throws, and **`importScripts()` in workers** only works for
  literal urls (they're pre-fetched when the worker starts).
- **SharedArrayBuffer / threads** need `crossOriginIsolated`, i.e. COOP/COEP headers on whatever
  hosts `index.html`. A single file on a static host usually doesn't have them.
- **UDP**: pages can't open raw UDP sockets in any browser, and WebRTC isn't proxied through wisp.
- Large `<video src>` files (not MSE) are downloaded fully before playing.
- **View Transitions are disabled in proxied pages.** Chrome 154 aborts the tab ("Error code: 5",
  a SIGTRAP from an internal CHECK) while snapshotting some same-document view transitions when the
  page lives in one of our frames; YouTube triggers it on every click into a regular video (Shorts
  don't use it). Sites feature-detect `document.startViewTransition`, so they just skip the
  animation.
- At a **null origin** (see below): nothing a site stores (cookies, localStorage) outlives the
  session, since the browser gives such documents no storage. Chrome switches the Navigation API's
  events off there, so navigations are caught where they start instead (links, forms,
  `form.submit()`, `location.*`, `window.open`, link targets, meta refresh, all tested); one started
  some other way would be lost. Back after a page's `pushState` in an about:blank popup reloads the
  url it went back to (Chrome won't traverse that window's history).
- From a **`file:` page**, Chrome won't load `blob:` scripts in workers: classic workers run their
  code without it, module workers don't work, and `importScripts()` inside workers fails.
- Inside a **sandboxed frame without `allow-same-origin`** no page can be shown at all: every frame
  in there gets an origin of its own. The app says so and offers to open itself in a new window
  (which works if the sandbox has `allow-popups-to-escape-sandbox`).

## Where it runs

| Opened as | Origin | Frames | Notes |
| --- | --- | --- | --- |
| an http(s) page | the site's | `blob:` documents, url set to the virtual one | the original setup |
| a `blob:` url made by such a page | the site's | `blob:` documents, url tracked | |
| an about:blank window its opener wrote the app into | the opener's | srcdoc documents, url tracked | Chrome makes blob: frames cross-origin there; detected at startup and per frame |
| a `data:` document, a `blob:null` page, about:blank written by one | null | srcdoc documents, url tracked | no Navigation API events: links, forms, `location.*`, targets and meta refresh are caught by hand |
| a `file:` page | null | srcdoc documents, url tracked | see the worker note above |

At a null origin, virtual urls live under `https://sjl.invalid/~/sj/` (a host that never resolves,
so nothing that escapes reaches a server), and localStorage/sessionStorage, which those documents
can't have, are replaced by in-memory stores for the session.

License: AGPL-3.0 (Scramjet and epoxy-transport are AGPL).
