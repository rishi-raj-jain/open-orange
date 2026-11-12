import { DurableObject } from "cloudflare:workers";

interface Env {
	GREETER: DurableObjectNamespace<Greeter>;
}

export class Greeter extends DurableObject<Env> {
	read(): { name: string | null; value: string | null } {
		return {
			name: this.ctx.id.name ?? null,
			value: this.ctx.storage.kv.get<string>("value") ?? null,
		};
	}

	write(value: string): void {
		this.ctx.storage.kv.put("value", value);
	}
}

export default {
	async fetch(request: Request, env: Env): Promise<Response> {
		const url = new URL(request.url);
		const namespace = url.searchParams.has("eu") ? env.GREETER.jurisdiction("eu") : env.GREETER;
		const name = url.searchParams.get("name");
		const id = url.searchParams.get("id");
		const value = url.searchParams.get("value");
		const objectId =
			name !== null
				? namespace.idFromName(name)
				: id !== null
					? namespace.idFromString(id)
					: namespace.newUniqueId();
		const stub = namespace.get(objectId);
		if (value !== null) await stub.write(value);
		return Response.json({ id: objectId.toString(), ...(await stub.read()) });
	},
};
