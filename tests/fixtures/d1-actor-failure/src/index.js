export default {
	async fetch(_request, env) {
		try {
			const row = await env.DB.prepare("SELECT 1 AS n").first();
			return new Response(String(row.n));
		} catch (error) {
			return new Response(error.message);
		}
	},
};
