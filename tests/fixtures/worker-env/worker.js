export default {
	fetch(request, env) {
		return Response.json({ API_KEY: env.API_KEY ?? null, GREETING: env.GREETING ?? null, OTHER: env.OTHER ?? null });
	},
};
