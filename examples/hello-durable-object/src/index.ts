import { DurableObject } from "cloudflare:workers";

interface Env {
	GREETER: DurableObjectNamespace<Greeter>;
}

// Each Greeter instance has its own SQLite database.
export class Greeter extends DurableObject<Env> {
	constructor(ctx: DurableObjectState, env: Env) {
		super(ctx, env);
		ctx.storage.sql.exec(
			"CREATE TABLE IF NOT EXISTS visits (visited_at INTEGER NOT NULL)",
		);
	}

	// Workers call this method over RPC through a stub.
	sayHello(name: string): { greeting: string; visits: number } {
		const sql = this.ctx.storage.sql;
		sql.exec("INSERT INTO visits (visited_at) VALUES (?)", Date.now());
		const { visits } = sql
			.exec<{ visits: number }>("SELECT count(*) AS visits FROM visits")
			.one();
		return { greeting: `Hello, ${name}!`, visits };
	}
}

export default {
	async fetch(request, env): Promise<Response> {
		const name = new URL(request.url).pathname.slice(1) || "World";
		// The same name always reaches the same Greeter instance.
		const stub = env.GREETER.getByName(name);
		return Response.json(await stub.sayHello(name));
	},
} satisfies ExportedHandler<Env>;
