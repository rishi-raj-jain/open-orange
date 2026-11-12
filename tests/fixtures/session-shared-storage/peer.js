export default {
	async fetch(request, env) {
		await env.DB.exec("CREATE TABLE IF NOT EXISTS t (v TEXT)");
		await env.DB.prepare("INSERT INTO t (v) VALUES (?)").bind("peer-row").run();
		await env.KV.put("from-peer", "peer-kv");
		await env.BUCKET.put("from-peer", "peer-object");
		return new Response("written");
	},
};
