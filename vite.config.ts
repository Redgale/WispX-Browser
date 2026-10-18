import { defineConfig } from "vite";
import { viteSingleFile } from "vite-plugin-singlefile";
import { fileURLToPath } from "node:url";

const scramjetDist = fileURLToPath(
	new URL("./node_modules/@mercuryworkshop/scramjet/dist", import.meta.url)
);
// the epoxy-tls client built from this project's epoxy-tls (WispX support), see vendor/epoxy-tls
const epoxy = fileURLToPath(new URL("./vendor/epoxy-tls/epoxy-bundled.js", import.meta.url));

export default defineConfig({
	// no SPA fallback: a stray request into the virtual /~/sj/ space should 404, not
	// load the browser UI inside a frame
	appType: "mpa",
	resolve: {
		alias: {
			// the package's "exports" map hides dist/, but we need the raw IIFE + wasm
			"@sj-dist": scramjetDist,
			"@epoxy": epoxy,
		},
	},
	// everything (scramjet, its wasm, epoxy + its wasm, the UI) ends up in one index.html
	plugins: [viteSingleFile({ removeViteModuleLoader: true })],
	build: {
		target: "es2022",
		assetsInlineLimit: Number.MAX_SAFE_INTEGER,
		chunkSizeWarningLimit: 20000,
		reportCompressedSize: false,
	},
	// keep the dev pre-bundler away from the raw scramjet IIFE
	optimizeDeps: { exclude: ["@mercuryworkshop/scramjet", "@sj-dist", "@epoxy"] },
	server: { port: 5173 },
	preview: { port: 4173 },
});
