import { DurableObject } from "cloudflare:workers";

export class Store extends DurableObject {
	async set(key, value) {
		await this.ctx.storage.put(key, value);
	}

	async get(key) {
		return (await this.ctx.storage.get(key)) ?? null;
	}

	async fetch(request) {
		const url = new URL(request.url);
		const key = url.searchParams.get("k");
		if (request.method === "PUT") {
			await this.ctx.storage.put(key, url.searchParams.get("v"));
			return new Response("ok");
		}
		return new Response(String((await this.ctx.storage.get(key)) ?? "null"));
	}
}

// Each round makes a call through one stub without awaiting it, then reads through a second stub.
export default {
	async fetch(request, env) {
		const url = new URL(request.url);
		const rounds = Number(url.searchParams.get("rounds"));
		const kind = url.searchParams.get("kind");
		const id = env.STORE.idFromName(url.searchParams.get("name"));
		const stale = [];
		for (let round = 0; round < rounds; round++) {
			const key = `k${round}`;
			const writer = env.STORE.get(id);
			const reader = env.STORE.get(id);
			let write;
			let read;
			if (kind === "rpc") {
				write = writer.set(key, String(round));
				read = await reader.get(key);
			} else {
				write = writer.fetch(`http://store/?k=${key}&v=${round}`, { method: "PUT" });
				read = await (await reader.fetch(`http://store/?k=${key}`)).text();
			}
			await write;
			if (read !== String(round)) stale.push({ round, read });
		}
		return Response.json({ stale });
	},
};
