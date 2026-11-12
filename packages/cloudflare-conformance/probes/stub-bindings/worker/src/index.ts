const calls: Record<string, (env: any) => Promise<unknown>> = {
	vectorize: (env) => env.VECTORIZE.query([0.1, 0.2], { topK: 1 }),
	images: (env) => env.IMAGES.info(new ReadableStream()),
	pipeline: (env) => env.PIPELINE.send([{ a: 1 }]),
	mtls: (env) => env.CERT.fetch("https://example.com"),
};

export default {
	async fetch(request: Request, env: unknown): Promise<Response> {
		const call = calls[new URL(request.url).pathname.slice(1)];
		if (call === undefined) return new Response("not found", { status: 404 });
		try {
			await call(env);
			return Response.json({ ok: true });
		} catch (error) {
			return Response.json({ ok: false, error: error instanceof Error ? error.message : String(error) });
		}
	},
};
