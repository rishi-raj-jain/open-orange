import type { Request, Response } from "../globals/http.js";

// A Worker's `globalOutbound` channel. The global fetch() and
// cloudflare:sockets connect() go through it instead of the network.
export interface GlobalOutboundFetcher {
	fetch(request: Request): Promise<Response>;
}

// `undefined` sends requests to the network, `null` blocks them, and a fetcher
// receives them.
let globalOutbound: GlobalOutboundFetcher | null | undefined;

export function setGlobalOutbound(outbound: GlobalOutboundFetcher | null | undefined): void {
	globalOutbound = outbound;
}

export function currentGlobalOutbound(): GlobalOutboundFetcher | null | undefined {
	return globalOutbound;
}

// https://github.com/cloudflare/workerd/blob/b73ce3ae105c35bafaaad864095079524573a465/src/workerd/server/server.c%2B%2B#L5182-L5189
export function globalOutboundBlockedError(): Error {
	return new Error(
		"This worker is not permitted to access the internet via global functions like fetch(). It must use capabilities (such as bindings in 'env') to talk to the outside world.",
	);
}
