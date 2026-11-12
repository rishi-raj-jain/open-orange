export default {
	async fetch(_request: Request, env: { BUCKET: R2Bucket }): Promise<Response> {
		await env.BUCKET.put("key", "value");
		return new Response("stored");
	},
};
