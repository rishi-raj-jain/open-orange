export default {
	async fetch(request, env) {
		const { pathname } = new URL(request.url);
		if (pathname === "/write-through-peer") return env.PEER.fetch("http://peer/write");
		await env.DB.exec("CREATE TABLE IF NOT EXISTS t (v TEXT)");
		await env.OTHER_DB.exec("CREATE TABLE IF NOT EXISTS t (v TEXT)");
		const row = await env.DB.prepare("SELECT v FROM t").first();
		const other = await env.OTHER_DB.prepare("SELECT v FROM t").first();
		const object = await env.BUCKET.get("from-peer");
		return Response.json({
			d1: row?.v ?? null,
			kv: await env.KV.get("from-peer"),
			otherDb: other?.v ?? null,
			r2: object === null ? null : await object.text(),
		});
	},
};
