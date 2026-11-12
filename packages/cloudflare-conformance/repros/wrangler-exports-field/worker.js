import { DurableObject } from "cloudflare:workers";

export class Counter extends DurableObject {
	async fetch() {
		const value = ((await this.ctx.storage.get("value")) ?? 0) + 1;
		await this.ctx.storage.put("value", value);
		return Response.json({ value });
	}
}

export default {
	fetch(request, env) {
		return env.COUNTER.getByName("a").fetch(request);
	},
};
