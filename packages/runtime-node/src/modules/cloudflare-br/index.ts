// The cloudflare:br module. BrowserRendering only forwards fetch() to the
// fetcher it wraps, so it works with any fetcher. Orange's Browser Rendering
// binding is a stub, so requests through that binding fail.
// https://github.com/cloudflare/workerd/blob/b73ce3ae105c35bafaaad864095079524573a465/src/cloudflare/internal/br-api.ts#L11-L24

import type { RequestInfo, RequestInit, Response } from "../../globals/http.js";
import type { URL } from "../../globals/url.js";

interface Fetcher {
	fetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response>;
}

export class BrowserRendering {
	readonly #fetcher: Fetcher;

	constructor(fetcher: Fetcher) {
		this.#fetcher = fetcher;
	}

	async fetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
		return this.#fetcher.fetch(input, init);
	}
}
