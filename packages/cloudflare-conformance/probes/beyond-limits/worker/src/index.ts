import { DurableObject } from "cloudflare:workers";

// Runs while the Worker loads, so a slow global scope is part of this probe.
const globalScopeStart = Date.now();
while (Date.now() - globalScopeStart < 1_500);

export class Big extends DurableObject {
	#held: Uint8Array[] = [];

	override async fetch(request: Request): Promise<Response> {
		const url = new URL(request.url);
		switch (url.pathname) {
			case "/cpu": {
				const until = Date.now() + Number(url.searchParams.get("ms"));
				let spins = 0;
				while (Date.now() < until) spins++;
				return Response.json({ spins });
			}
			case "/hold": {
				const megabytes = Number(url.searchParams.get("mb"));
				for (let i = 0; i < megabytes; i += 64) this.#held.push(new Uint8Array(64 * 1024 * 1024).fill(7));
				return Response.json({ heldMb: this.#held.length * 64 });
			}
			case "/held":
				return Response.json({ heldMb: this.#held.length * 64, sample: this.#held.at(-1)?.[1024] ?? null });
			default:
				return new Response("not found", { status: 404 });
		}
	}
}

export default {
	async fetch(request: Request, env: { BIG: DurableObjectNamespace }): Promise<Response> {
		const url = new URL(request.url);
		switch (url.pathname) {
			case "/subrequests": {
				const count = Number(url.searchParams.get("count"));
				let ok = 0;
				for (let batch = 0; batch < count; batch += 50) {
					const responses = await Promise.all(
						Array.from({ length: Math.min(50, count - batch) }, () => fetch(new URL("/ping", url))),
					);
					for (const response of responses) {
						await response.text();
						if (response.ok) ok++;
					}
				}
				return Response.json({ ok });
			}
			case "/ping":
				return new Response("pong");
			case "/upload": {
				let bytes = 0;
				const reader = request.body!.getReader();
				for (;;) {
					const { done, value } = await reader.read();
					if (done) break;
					bytes += value.length;
				}
				return Response.json({ bytes });
			}
			default:
				return env.BIG.get(env.BIG.idFromName("big")).fetch(request);
		}
	},
};
