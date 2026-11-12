// Writes and reads one value through each storage binding.
export default {
	async fetch(request, env) {
		const { pathname } = new URL(request.url);
		const [, store, key] = pathname.split("/");
		if (store === "r2") {
			if (request.method === "PUT") {
				await env.BUCKET.put(key, await request.text());
				return new Response("stored");
			}
			const object = await env.BUCKET.get(key);
			return object === null ? new Response("missing", { status: 404 }) : new Response(await object.text());
		}
		if (store === "kv") {
			if (request.method === "PUT") {
				await env.KV.put(key, await request.text());
				return new Response("stored");
			}
			const value = await env.KV.get(key);
			return value === null ? new Response("missing", { status: 404 }) : new Response(value);
		}
		if (store === "d1") {
			await env.DB.prepare("CREATE TABLE IF NOT EXISTS notes (key TEXT PRIMARY KEY, value TEXT)").run();
			if (request.method === "PUT") {
				await env.DB.prepare("INSERT INTO notes (key, value) VALUES (?, ?)").bind(key, await request.text()).run();
				return new Response("stored");
			}
			const row = await env.DB.prepare("SELECT value FROM notes WHERE key = ?").bind(key).first();
			return row === null ? new Response("missing", { status: 404 }) : new Response(row.value);
		}
		return new Response("not found", { status: 404 });
	},
};
