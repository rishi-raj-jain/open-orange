import { DurableObject } from "cloudflare:workers";

export class Counter extends DurableObject {
	async fetch() {
		const count = ((await this.ctx.storage.get("count")) ?? 0) + 1;
		await this.ctx.storage.put("count", count);
		return Response.json({ count });
	}
}

export default {
	async fetch(request) {
		return Response.json({ worker: "peer", path: new URL(request.url).pathname });
	},
	async scheduled(controller, env) {
		await env.KV.put("cron-peer", "peer");
	},
	async queue(batch, env) {
		for (const message of batch.messages) await env.KV.put("queued", `peer:${message.body.text}`);
	},
};
