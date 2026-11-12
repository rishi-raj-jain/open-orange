// Only requests that match `run_worker_first` reach this Worker. Assets and
// the single-page app fallback handle everything else.
export default {
	async fetch(request): Promise<Response> {
		const { pathname } = new URL(request.url);
		if (pathname === "/api/hello") {
			return Response.json({ message: "Hello from the Worker" });
		}
		return Response.json({ error: `No API route for ${pathname}` }, { status: 404 });
	},
} satisfies ExportedHandler;
