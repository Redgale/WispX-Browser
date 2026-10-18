# epoxy-tls client (WispX build)

Built from `client/` in [WispX-Rust](TODO-WISPX-RUST-URL) (commit 9c0b9db) with
`RELEASE=1 bash build.sh`; `epoxy-bundled.js` has the wasm inlined. It adds the `wispx`
option (WispX, falling back to Wisp v2/v1 on servers without it) to the published 2.1.19 client.
To update: rebuild there and copy `pkg/epoxy-bundled.js` and `pkg/epoxy-bundled.d.ts` here.
