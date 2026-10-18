const svg = (body: string, extra = "") =>
	`<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" ${extra}>${body}</svg>`;

export const icons = {
	back: svg('<path d="M19 12H5"/><path d="m12 19-7-7 7-7"/>'),
	forward: svg('<path d="M5 12h14"/><path d="m12 5 7 7-7 7"/>'),
	reload: svg('<path d="M21 12a9 9 0 1 1-2.64-6.36"/><path d="M21 3v6h-6"/>'),
	stop: svg('<path d="M18 6 6 18"/><path d="m6 6 12 12"/>'),
	home: svg('<path d="m3 11 9-8 9 8"/><path d="M5 10v10h5v-6h4v6h5V10"/>'),
	plus: svg('<path d="M12 5v14"/><path d="M5 12h14"/>'),
	close: svg('<path d="M18 6 6 18"/><path d="m6 6 12 12"/>', 'width="14" height="14"'),
	fullscreen: svg('<path d="M8 3H5a2 2 0 0 0-2 2v3"/><path d="M21 8V5a2 2 0 0 0-2-2h-3"/><path d="M3 16v3a2 2 0 0 0 2 2h3"/><path d="M16 21h3a2 2 0 0 0 2-2v-3"/>'),
	exitFullscreen: svg('<path d="M8 3v3a2 2 0 0 1-2 2H3"/><path d="M21 8h-3a2 2 0 0 1-2-2V3"/><path d="M3 16h3a2 2 0 0 1 2 2v3"/><path d="M16 21v-3a2 2 0 0 1 2-2h3"/>'),
	menu: svg('<circle cx="12" cy="5" r="1.2" fill="currentColor"/><circle cx="12" cy="12" r="1.2" fill="currentColor"/><circle cx="12" cy="19" r="1.2" fill="currentColor"/>'),
	lock: svg('<rect x="5" y="11" width="14" height="10" rx="2"/><path d="M8 11V7a4 4 0 0 1 8 0v4"/>', 'width="14" height="14"'),
	unlocked: svg('<rect x="5" y="11" width="14" height="10" rx="2"/><path d="M8 11V7a4 4 0 0 1 7.8-1.3"/>', 'width="14" height="14"'),
	search: svg('<circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/>', 'width="14" height="14"'),
	globe: svg('<circle cx="12" cy="12" r="9"/><path d="M3 12h18"/><path d="M12 3a14 14 0 0 1 0 18a14 14 0 0 1 0-18"/>', 'width="16" height="16"'),
	shield: svg('<path d="M12 3 4 6v6c0 5 3.4 8.3 8 9 4.6-.7 8-4 8-9V6z"/>', 'width="16" height="16"'),
	trash: svg('<path d="M4 7h16"/><path d="M10 11v6"/><path d="M14 11v6"/><path d="M6 7l1 13h10l1-13"/><path d="M9 7V4h6v3"/>', 'width="16" height="16"'),
	code: svg('<path d="m8 17-5-5 5-5"/><path d="m16 7 5 5-5 5"/><path d="m13.5 4-3 16"/>'),
	info: svg('<circle cx="12" cy="12" r="9"/><path d="M12 11v5"/><path d="M12 8h.01"/>', 'width="16" height="16"'),
	mail: svg('<rect x="3" y="5" width="18" height="14" rx="2"/><path d="m3 7 9 6 9-6"/>', 'width="16" height="16"'),
	warning: svg('<path d="M12 3 2 20h20z"/><path d="M12 10v4"/><path d="M12 17h.01"/>', 'width="40" height="40" stroke-width="1.6"'),
};
