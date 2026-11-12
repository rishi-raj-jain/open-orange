import { DurableObject } from "cloudflare:workers";

interface Env {
	SLOW: DurableObjectNamespace<SlowStart>;
}

// The constructor stays inside Cloudflare's 30 second limit, and counts its own runs in storage.
export class SlowStart extends DurableObject<Env> {
	readonly #instance = crypto.randomUUID();

	constructor(ctx: DurableObjectState, env: Env) {
		super(ctx, env);
		void ctx.blockConcurrencyWhile(async () => {
			ctx.storage.sql.exec("CREATE TABLE IF NOT EXISTS starts (id INTEGER PRIMARY KEY)");
			ctx.storage.sql.exec("INSERT INTO starts DEFAULT VALUES");
			await new Promise((resolve) => setTimeout(resolve, 22_000));
		});
	}

	status(): { instance: string; starts: number } {
		const [row] = this.ctx.storage.sql.exec<{ n: number }>("SELECT count(*) AS n FROM starts").toArray();
		return { instance: this.#instance, starts: row?.n ?? 0 };
	}
}

export default {
	async fetch(_request: Request, env: Env): Promise<Response> {
		return Response.json(await env.SLOW.get(env.SLOW.idFromName("slow")).status());
	},
};
