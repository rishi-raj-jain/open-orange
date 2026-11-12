import { Response } from "../globals/http.js";
import {
	createDurableObjectNamespace,
	type DurableObjectNamespace,
} from "../bindings/durable-objects/namespace.js";
import { workerNotFoundMessage } from "./workers.js";

// A Durable Object binding whose script_name names a Worker that is not in the
// `orange dev` session. Like Wrangler's dev registry proxy, IDs work, fetch()
// answers 503, and every other call throws.
// https://github.com/cloudflare/workers-sdk/blob/be87ff0382c53a294e948e49419d25d653c50e86/packages/miniflare/src/workers/core/dev-registry-proxy-shared.worker.ts#L230-L259
export function createMissingWorkerDurableObjectNamespace(
	className: string,
	scriptName: string,
): DurableObjectNamespace {
	const namespace = createDurableObjectNamespace({
		className,
		deploymentIdentity: `missing-worker:${scriptName}`,
	});
	const message = workerNotFoundMessage(scriptName);
	const stubFor = <Stub extends object>(stub: Stub): Stub =>
		new Proxy(stub, {
			get(target, property, receiver): unknown {
				if (property === "id" || property === "name" || typeof property === "symbol") {
					return Reflect.get(target, property, receiver);
				}
				if (property === "then") return undefined;
				if (property === "fetch") {
					return () => Promise.resolve(new Response(message, { status: 503 }));
				}
				return () => {
					throw new Error(message);
				};
			},
		});
	return {
		...namespace,
		get: (id, options) => stubFor(namespace.get(id, options)),
		getByName: (name, options) =>
			stubFor(namespace.getByName(name, options)),
	};
}
