import { WorkerEntrypoint } from "cloudflare:workers";

let seen;

export class Server extends WorkerEntrypoint {
	async fetch(request) {
		seen = {};
		const clone = request.clone();
		const copy = new Request(request);
		copy.signal.addEventListener("abort", () => {
			seen.copy = copy.signal.reason.message;
		});
		clone.signal.addEventListener("abort", () => {
			seen.clone = clone.signal.reason.message;
		});
		request.signal.addEventListener("abort", () => {
			seen.original = request.signal.reason.message;
		});
		await new Promise(() => {});
	}
}

export default {
	async fetch(request, env) {
		let failure;
		await env.SERVER.fetch("http://example.com", { signal: AbortSignal.timeout(100) }).catch((error) => {
			failure = error.message;
		});
		await new Promise((resolve) => setTimeout(resolve, 100));
		return Response.json({ failure, flag: Cloudflare.compatibilityFlags.request_signal_passthrough, seen });
	},
};
