/// <reference types="vite/client" />
import type {} from "@mercuryworkshop/scramjet";

declare module "*.js?raw" {
	const src: string;
	export default src;
}

interface ImportMetaEnv {
	readonly VITE_DEFAULT_WISP?: string;
}
