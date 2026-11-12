export default {
	async fetch(request, env) {
		const url = new URL(request.url);
		if (url.pathname === "/count") return env.COUNTER.getByName("a").fetch(request);
		if (url.pathname === "/send") {
			await env.JOBS.send({ text: url.searchParams.get("text") });
			return Response.json({ sent: true });
		}
		if (url.pathname === "/kv") return Response.json(await env.KV.get(url.searchParams.get("key") ?? ""));
		if (url.pathname === "/ws") {
			const [client, server] = Object.values(new WebSocketPair());
			server.accept();
			server.addEventListener("message", (event) => server.send(`echo:${event.data}`));
			return new Response(null, { status: 101, webSocket: client });
		}
		return Response.json({ worker: "primary", host: url.host });
	},
	async scheduled(controller, env) {
		await env.KV.put("cron-primary", "primary");
	},
};
