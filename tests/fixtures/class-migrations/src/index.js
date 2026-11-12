import { DurableObject } from "cloudflare:workers";

class Counter extends DurableObject {
	inc() {
		this.ctx.storage.sql.exec("CREATE TABLE IF NOT EXISTS c (k TEXT PRIMARY KEY, v INTEGER)");
		return this.ctx.storage.sql
			.exec("INSERT INTO c VALUES ('n', 1) ON CONFLICT(k) DO UPDATE SET v = v + 1 RETURNING v")
			.one().v;
	}
}

export class OldRoom extends Counter {}
export class NewRoom extends Counter {}
export class Retired extends Counter {}

export default {
	async fetch(request, env) {
		const { pathname, searchParams } = new URL(request.url);
		const json = (value) => Response.json(value);
		switch (pathname) {
			case "/named":
				return json(await env.ROOM.getByName("a").inc());
			case "/unique": {
				const id = env.ROOM.newUniqueId();
				return json({ id: id.toString(), value: await env.ROOM.get(id).inc() });
			}
			case "/by-id":
				return json(await env.ROOM.get(env.ROOM.idFromString(searchParams.get("id"))).inc());
			case "/retired":
				return json(env.RETIRED === undefined ? "no binding" : await env.RETIRED.getByName("a").inc());
			default:
				return new Response("not found", { status: 404 });
		}
	},
};
