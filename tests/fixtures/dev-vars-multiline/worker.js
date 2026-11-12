export default {
	async fetch(request, env) {
		return Response.json({ key: env.SIGNING_KEY, after: env.AFTER });
	},
};
