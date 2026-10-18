// Serves the built app for local testing: dist/index.html at /, the launcher at /launch.html.
//   node tools/serve.mjs [port]      (default 4173)
// No dependencies; nothing is cached, so a rebuild shows up on reload.
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const port = Number(process.argv[2]) || 4173;
const files = {
	"/": path.join(root, "dist/index.html"),
	"/index.html": path.join(root, "dist/index.html"),
	"/launch.html": path.join(root, "tools/launch.html"),
};

http
	.createServer((req, res) => {
		const file = files[new URL(req.url, "http://x").pathname];
		if (!file) {
			res.writeHead(404, { "content-type": "text/plain" }).end("not found");
			return;
		}
		fs.readFile(file, (err, data) => {
			if (err) return res.writeHead(500).end(String(err));
			res.writeHead(200, {
				"content-type": "text/html; charset=utf-8",
				"cache-control": "no-store",
				// lets launchers at other (or opaque) origins fetch the app
				"access-control-allow-origin": "*",
			});
			res.end(data);
		});
	})
	.listen(port, "127.0.0.1", () => console.log(`app: http://localhost:${port}/  launcher: http://localhost:${port}/launch.html`));
