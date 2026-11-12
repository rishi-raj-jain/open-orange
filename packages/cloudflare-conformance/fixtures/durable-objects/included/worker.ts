import { DurableObject } from "cloudflare:workers";

interface Env {
	COUNTER: DurableObjectNamespace<Counter>;
}

export class Counter extends DurableObject<Env> {
	async increment(): Promise<number> {
		const current = (await this.ctx.storage.get<number>("count")) ?? 0;
		await this.ctx.storage.put("count", current + 1);
		return current + 1;
	}

	async fetch(): Promise<Response> {
		return Response.json({ count: await this.increment() });
	}
}

export default {
	async fetch(_request: Request, env: Env): Promise<Response> {
		return Response.json({ count: await env.COUNTER.getByName("main").increment() });
	},
} satisfies ExportedHandler<Env>;
