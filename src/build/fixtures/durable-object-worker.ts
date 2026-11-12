import { DurableObject } from "cloudflare:workers";

export class ConfiguredObject extends DurableObject {
	static methodCalls = 0;

	fetch(): Response {
		ConfiguredObject.methodCalls += 1;
		return new Response("durable object method");
	}
}

export class UnconfiguredObject extends DurableObject {
	fetch(): Response {
		return new Response("unconfigured durable object method");
	}
}

export default {
	fetch(request: Request, env: Record<string, unknown>): Response {
		if (new URL(request.url).pathname === "/namespace") {
			const namespace = Reflect.get(env, "OBJECT");
			if (typeof namespace !== "object" || namespace === null) {
				throw new TypeError("OBJECT namespace is missing");
			}
			const getByName = Reflect.get(namespace, "getByName");
			if (typeof getByName !== "function") {
				throw new TypeError("OBJECT namespace getByName is missing");
			}
			const stub: unknown = Reflect.apply(getByName, namespace, ["fixture"]);
			if (typeof stub !== "object" || stub === null) {
				throw new TypeError("OBJECT namespace returned an invalid stub");
			}
			const id: unknown = Reflect.get(stub, "id");
			return Response.json({
				id: String(id),
				name: Reflect.get(stub, "name"),
			});
		}
		return new Response("worker fetch");
	},
};
