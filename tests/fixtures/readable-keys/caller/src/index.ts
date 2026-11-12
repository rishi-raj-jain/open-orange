interface Env {
	GREETER: DurableObjectNamespace;
	GREETER_WORKER: Fetcher;
}

interface Greeter {
	read(): Promise<{ name: string | null; value: string | null }>;
}

// Reads a Greeter of the other Worker by name or by ID string. `?direct` asks the other
// Worker itself instead.
export default {
	async fetch(request: Request, env: Env): Promise<Response> {
		const url = new URL(request.url);
		if (url.searchParams.has("direct")) return env.GREETER_WORKER.fetch(request);
		const name = url.searchParams.get("name");
		const id = url.searchParams.get("id") ?? "";
		const objectId = name !== null ? env.GREETER.idFromName(name) : env.GREETER.idFromString(id);
		const stub = env.GREETER.get(objectId) as unknown as Greeter;
		return Response.json({ id: objectId.toString(), ...(await stub.read()) });
	},
};
