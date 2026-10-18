import { icons } from "./icons";

export const SHORTCUTS: Array<{ name: string; url: string; color: string }> = [
	{ name: "DuckDuckGo", url: "https://duckduckgo.com/", color: "#de5833" },
	{ name: "Wikipedia", url: "https://en.wikipedia.org/", color: "#636466" },
	{ name: "GitHub", url: "https://github.com/", color: "#6e5494" },
	{ name: "YouTube", url: "https://www.youtube.com/", color: "#e62117" },
	{ name: "Reddit", url: "https://old.reddit.com/", color: "#ff4500" },
	{ name: "Hacker News", url: "https://news.ycombinator.com/", color: "#ff6600" },
	{ name: "Poki", url: "https://poki.com/", color: "#1a8cff" },
	{ name: "Archive", url: "https://archive.org/", color: "#428bca" },
];

function greeting() {
	const h = new Date().getHours();
	if (h < 5) return "Good night";
	if (h < 12) return "Good morning";
	if (h < 18) return "Good afternoon";
	return "Good evening";
}

export function renderNewTab(onGo: (input: string) => void, engineName: string): HTMLElement {
	const root = document.createElement("div");
	root.className = "newtab";
	root.innerHTML = `
		<div class="newtab-inner">
			<div class="newtab-greeting"></div>
			<form class="newtab-search" autocomplete="off">
				<span class="newtab-search-icon">${icons.search}</span>
				<input type="text" spellcheck="false" aria-label="Search or enter address" />
			</form>
			<div class="newtab-tiles"></div>
			<p class="newtab-note">Pages load through your wisp server without a service worker, so the URL of this page never changes.</p>
		</div>`;
	root.querySelector(".newtab-greeting")!.textContent = greeting();
	const input = root.querySelector("input")!;
	input.placeholder = `Search ${engineName} or type a URL`;
	root.querySelector("form")!.addEventListener("submit", (e) => {
		e.preventDefault();
		if (input.value.trim()) onGo(input.value);
	});
	const tiles = root.querySelector(".newtab-tiles")!;
	for (const s of SHORTCUTS) {
		const a = document.createElement("a");
		a.className = "tile";
		a.href = "#";
		a.title = s.url;
		a.innerHTML = `<span class="tile-icon"></span><span class="tile-name"></span>`;
		const icon = a.querySelector<HTMLElement>(".tile-icon")!;
		icon.textContent = s.name[0];
		icon.style.background = s.color;
		a.querySelector(".tile-name")!.textContent = s.name;
		a.addEventListener("click", (e) => {
			e.preventDefault();
			onGo(s.url);
		});
		tiles.append(a);
	}
	return root;
}
