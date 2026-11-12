interface Env {
	NOTES: KVNamespace;
}

export default {
	async fetch(request, env): Promise<Response> {
		const url = new URL(request.url);
		if (url.pathname === "/notes") {
			// List keys, optionally filtered with ?prefix=.
			const prefix = url.searchParams.get("prefix") ?? undefined;
			const { keys } = await env.NOTES.list({ prefix });
			return Response.json({ keys });
		}

		const key = /^\/notes\/(.+)$/.exec(url.pathname)?.[1];
		if (key === undefined) {
			return new Response("Try /notes or /notes/<key>", { status: 404 });
		}

		switch (request.method) {
			case "GET": {
				const value = await env.NOTES.get(key);
				return value === null
					? new Response(`No note named ${key}`, { status: 404 })
					: new Response(value);
			}
			case "PUT": {
				// ?ttl=<seconds> makes the note expire. KV requires at least 60.
				const ttl = url.searchParams.get("ttl");
				try {
					await env.NOTES.put(key, await request.text(), {
						expirationTtl: ttl === null ? undefined : Number(ttl),
					});
				} catch (error) {
					const message = error instanceof Error ? error.message : String(error);
					return new Response(message, { status: 400 });
				}
				return new Response(null, { status: 204 });
			}
			case "DELETE":
				await env.NOTES.delete(key);
				return new Response(null, { status: 204 });
			default:
				return new Response("Use GET, PUT, or DELETE", { status: 405 });
		}
	},
} satisfies ExportedHandler<Env>;
