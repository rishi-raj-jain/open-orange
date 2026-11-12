// cloudflare:node routes fetch requests to node:http servers by port.
// https://github.com/cloudflare/workerd/blob/b73ce3ae105c35bafaaad864095079524573a465/src/cloudflare/node.ts#L1-L113

import { portMapper, type PortHandler } from "../node-http/port-mapper.js";

interface ServerDescriptor {
	port?: number | null | undefined;
}

interface NodeStyleServer {
	listen(...args: unknown[]): unknown;
	address(): { port?: number | null | undefined } | string | null;
}

function validatePort(port: unknown): number {
	if (
		typeof port !== "number" ||
		!Number.isFinite(port) ||
		port < 0 ||
		port > 65535
	) {
		throw new Error("Failed to determine port for server");
	}
	return port;
}

function isNodeStyleServer(value: object): value is NodeStyleServer {
	return (
		"listen" in value &&
		typeof value.listen === "function" &&
		"address" in value &&
		typeof value.address === "function"
	);
}

function serverPort(server: NodeStyleServer): number | undefined {
	const address = server.address();
	return typeof address === "object" && address !== null && typeof address.port === "number"
		? address.port
		: undefined;
}

export async function handleAsNodeRequest(
	desc: number | ServerDescriptor,
	request: Request,
	env?: unknown,
	ctx?: unknown,
): Promise<Response> {
	const descriptor = typeof desc === "number" ? { port: desc } : desc;
	const port = validatePort(descriptor?.port);
	const instance = portMapper.get(port);
	if (instance === undefined) {
		throw Object.assign(
			new Error(
				`Http server with port ${port} not found. This is likely a bug with your code. ` +
					`You should check if server.listen() was called with the same port (${port})`,
			),
			{ code: "ERR_INVALID_ARG_VALUE" },
		);
	}
	return await instance.fetch(request, env, ctx);
}

export function httpServerHandler(
	desc: number | ServerDescriptor | NodeStyleServer,
): PortHandler {
	const descriptor = typeof desc === "number" ? { port: desc } : desc;
	if (descriptor == null) {
		throw new Error("Server descriptor cannot be null or undefined");
	}
	const isObject = typeof descriptor === "object";
	let port: unknown =
		isObject && "port" in descriptor ? descriptor.port : undefined;
	if (port == null && isObject && isNodeStyleServer(descriptor)) {
		port = serverPort(descriptor);
		if (port === undefined) {
			// listen() assigns the virtual port synchronously.
			descriptor.listen();
			port = serverPort(descriptor);
		}
	}
	const validated = validatePort(port);
	return {
		async fetch(request: Request, env?: unknown, ctx?: unknown): Promise<Response> {
			return await handleAsNodeRequest({ port: validated }, request, env, ctx);
		},
	};
}

export default { handleAsNodeRequest, httpServerHandler };
