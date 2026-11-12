export default {
	async fetch(request) {
		const forwarded = [...request.headers.keys()].filter((name) => name.startsWith("x-orange-forwarded"));
		return Response.json({ worker: "status", host: new URL(request.url).host, forwarded });
	},
};
