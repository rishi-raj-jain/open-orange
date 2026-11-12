interface VersionMetadata {
	id: string;
	tag: string;
	timestamp: string;
}

interface Environment {
	TOML_SECRET: { get(): Promise<string> };
	TOML_VERSION: VersionMetadata;
}

export default {
	async fetch(request: Request, env: Environment): Promise<Response> {
		if (new URL(request.url).pathname === "/version-metadata") {
			return Response.json(env.TOML_VERSION);
		}
		if (new URL(request.url).pathname === "/secret-store") {
			return new Response(await env.TOML_SECRET.get());
		}
		if (new URL(request.url).pathname === "/log") {
			console.log("fixture log line");
			return new Response("logged");
		}
		if (new URL(request.url).pathname === "/throws") {
			throw new TypeError("fixture failure");
		}
		return new Response("ok");
	},
};
