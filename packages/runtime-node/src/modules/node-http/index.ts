// node:http for Workers. Servers never bind a host port: like workerd,
// listen() registers the server in a per-Worker port map and requests reach it
// through cloudflare:node.
// https://github.com/cloudflare/workerd/blob/b73ce3ae105c35bafaaad864095079524573a465/src/node/internal/internal_http_server.ts#L173-L370

import * as http from "node:http";
import { isIPv4, type AddressInfo } from "node:net";
import type { Duplex } from "node:stream";

import {
	ERR_INVALID_ARG_VALUE,
	ERR_SERVER_ALREADY_LISTEN,
} from "../node-internal/errors.js";
import { validatePort } from "../node-internal/validators.js";
import { duplexPair } from "./duplex-pair.js";
import { nodeRequestHeaders, toFetchResponse } from "./fetch-conversion.js";
import {
	findSuitablePort,
	normalizeListenArgs,
	portMapper,
} from "./port-mapper.js";

export * from "node:http";

// Sends a fetch Request through Node.js' HTTP parser over an in-memory socket.
function dispatchToServer(
	server: http.Server,
	request: Request,
	env: unknown,
	ctx: unknown,
): Promise<Response> {
	const [client, serverSide] = duplexPair();
	const address = server.address();
	defineSocketAddress(serverSide, request.headers, typeof address === "string" ? undefined : address?.port);
	const cloudflare: Record<string, unknown> = { ctx, env };
	if ("cf" in request) cloudflare.cf = request.cf;
	const response = new Promise<Response>((resolve, reject) => {
		const pending: PendingDispatch = { cloudflare, reject, responseFinished: false };
		pendingDispatches.set(serverSide, pending);
		sendRequest(client, request, () => pending.responseFinished).then(resolve, reject);
	});
	server.emit("connection", serverSide);
	return response;
}

// The in-memory socket reports the addresses that workerd gives a request's
// socket, which libraries such as Express read for `req.ip` and `req.secure`.
// https://github.com/cloudflare/workerd/blob/b73ce3ae105c35bafaaad864095079524573a465/src/node/internal/internal_http_incoming.ts#L88-L165
function defineSocketAddress(socket: Duplex, headers: Headers, localPort: number | undefined): void {
	const connectingIp = headers.get("cf-connecting-ip");
	const remotePort = (Math.random() * 0x8000) | 0x8000;
	const connected = <Value>(value: Value): (() => Value | undefined) => () =>
		socket.destroyed ? undefined : value;
	Object.defineProperties(socket, {
		encrypted: { configurable: true, value: headers.get("x-forwarded-proto") === "https" },
		localAddress: { configurable: true, value: headers.get("host") ?? "127.0.0.1" },
		localPort: { configurable: true, value: localPort },
		remoteAddress: { configurable: true, get: connected(connectingIp ?? "127.0.0.1") },
		remoteFamily: {
			configurable: true,
			get: connected(connectingIp === null || isIPv4(connectingIp) ? "IPv4" : "IPv6"),
		},
		remotePort: { configurable: true, get: connected(remotePort) },
	});
}

function sendRequest(
	client: Duplex,
	request: Request,
	responseFinished: () => boolean,
): Promise<Response> {
	const url = new URL(request.url);
	const headers = nodeRequestHeaders(request);
	return new Promise<Response>((resolve, reject) => {
		const outgoing = http.request({
			createConnection: () => client,
			headers,
			method: request.method,
			path: url.pathname + url.search,
		});
		outgoing.on("error", reject);
		outgoing.on("response", (incoming) => {
			resolve(toFetchResponse(request, incoming, incoming, responseFinished));
		});
		if (request.body === null) {
			outgoing.end();
			return;
		}
		const reader = request.body.getReader();
		const pump = async (): Promise<void> => {
			for (;;) {
				const { done, value } = await reader.read();
				if (done) break;
				if (!outgoing.write(value)) {
					await new Promise((drained) => outgoing.once("drain", drained));
				}
			}
			outgoing.end();
		};
		pump().catch((error: unknown) =>
			outgoing.destroy(error instanceof Error ? error : new Error(String(error))),
		);
	});
}

// workerd rejects request targets that would replace the configured authority
// when resolved against it: `//host`, any `/` and `\\` pair, or a scheme.
// https://github.com/cloudflare/workerd/blob/b73ce3ae105c35bafaaad864095079524573a465/src/node/internal/internal_http_client.ts#L50-L53
const AUTHORITY_OVERRIDE_REGEX = /^(?:[/\\]{2}|[^/\\]*:)/;

function requestPathError(path: unknown): Error | undefined {
	if (typeof path === "string" && AUTHORITY_OVERRIDE_REGEX.test(path)) {
		return new ERR_INVALID_ARG_VALUE(
			"options.path",
			path,
			"must be a path-only request target",
		);
	}
	return undefined;
}

function validateRequestPath(path: unknown): void {
	const error = requestPathError(path);
	if (error !== undefined) throw error;
}

function optionsPath(args: readonly unknown[]): unknown {
	for (const arg of args.slice(0, 2)) {
		if (typeof arg === "object" && arg !== null && !(arg instanceof URL)) {
			if ("path" in arg) return arg.path;
		}
	}
	return undefined;
}

type ClientRequestArgs = ConstructorParameters<typeof http.ClientRequest>;

// https://github.com/cloudflare/workerd/blob/b73ce3ae105c35bafaaad864095079524573a465/src/node/internal/internal_http_client.ts#L115-L139
export class ClientRequest extends http.ClientRequest {
	constructor(...args: ClientRequestArgs) {
		validateRequestPath(optionsPath(args));
		super(...args);
	}

	// `path` is a public field, so workerd checks it again before sending.
	// https://github.com/cloudflare/workerd/blob/b73ce3ae105c35bafaaad864095079524573a465/src/node/internal/internal_http_client.ts#L380-L392
	#rejectMutatedPath(): boolean {
		if (this.headersSent) return false;
		const error = requestPathError(this.path);
		if (error === undefined) return false;
		this.destroy(error);
		return true;
	}

	override write(...args: unknown[]): boolean {
		if (this.#rejectMutatedPath()) return false;
		return Boolean(Reflect.apply(super.write, this, args));
	}

	override end(...args: unknown[]): this {
		if (this.#rejectMutatedPath()) return this;
		// OutgoingMessage.end() always returns the message itself.
		Reflect.apply(super.end, this, args);
		return this;
	}

	override flushHeaders(): void {
		if (this.#rejectMutatedPath()) return;
		super.flushHeaders();
	}

	// workerd's destroy() without an error closes the request quietly. Node
	// emits "socket hang up" unless the request was aborted.
	override destroy(error?: Error): this {
		if (
			error === undefined &&
			!this.destroyed &&
			Reflect.get(this, "res") == null
		) {
			Reflect.set(this, "aborted", true);
		}
		return super.destroy(error);
	}
}

export function request(...args: unknown[]): ClientRequest {
	// SAFETY: Node's ClientRequest accepts the (url, options, callback) forms of http.request at runtime and validates them itself, but @types/node declares only its (urlOrOptions, callback) constructor.
	return new ClientRequest(...(args as ClientRequestArgs));
}

export function get(...args: unknown[]): ClientRequest {
	const outgoing = request(...args);
	outgoing.end();
	return outgoing;
}

// Errors thrown by a request listener reject the fetch that caused them
// instead of escaping as uncaught exceptions, like workerd's synchronous emit.
// https://github.com/cloudflare/workerd/blob/b73ce3ae105c35bafaaad864095079524573a465/src/node/internal/internal_http_server.ts#L210-L225
interface PendingDispatch {
	cloudflare: Record<string, unknown>;
	reject(error: unknown): void;
	/** Whether the server's ServerResponse has emitted `finish`. */
	responseFinished: boolean;
}

const pendingDispatches = new WeakMap<object, PendingDispatch>();

// In workerd a request's body and its response are separate streams, so destroying the request
// leaves the response writable. Node.js shares one socket between them and destroys it, which
// here would end the fetch with "socket hang up".
// https://github.com/cloudflare/workerd/blob/b73ce3ae105c35bafaaad864095079524573a465/src/node/internal/internal_http_incoming.ts
class BridgedIncomingMessage extends http.IncomingMessage {
	override _destroy(error: Error | null, callback: (error?: Error | null) => void): void {
		if (pendingDispatches.has(this.socket)) {
			callback(error);
			return;
		}
		super._destroy(error, callback);
	}
}

type ServerArgs = [options?: http.ServerOptions | http.RequestListener, listener?: http.RequestListener];

export class Server extends http.Server {
	#port: number | null = null;

	constructor(...args: ServerArgs) {
		const [options, listener] = args;
		if (typeof options === "function") {
			super({ IncomingMessage: BridgedIncomingMessage } as http.ServerOptions, options);
		} else if (options == null || (typeof options === "object" && !Array.isArray(options))) {
			super({ IncomingMessage: BridgedIncomingMessage, ...options } as http.ServerOptions, listener);
		} else {
			// Node.js rejects options that are not an object with ERR_INVALID_ARG_TYPE.
			super(...(args as [http.ServerOptions, http.RequestListener?]));
		}
	}

	override emit(event: string | symbol, ...args: unknown[]): boolean {
		const emitBase = (): boolean =>
			Boolean(Reflect.apply(http.Server.prototype.emit, this, [event, ...args]));
		const incoming = args[0];
		if (event !== "request" || !(incoming instanceof http.IncomingMessage)) {
			return emitBase();
		}
		const socket = incoming.socket;
		const pending = pendingDispatches.get(socket);
		// workerd exposes the Worker env, ctx, and cf on the request.
		if (pending !== undefined) {
			Reflect.set(incoming, "cloudflare", pending.cloudflare);
			const response = args[1];
			if (response instanceof http.ServerResponse) {
				// Each dispatch has its own socket pair, so the response is the last thing the server
				// sends. Ending the socket ends a body that is shorter than its Content-Length,
				// which a keep-alive request would otherwise leave waiting for more bytes.
				response.once("finish", () => {
					pending.responseFinished = true;
					socket.end();
				});
			}
		}
		try {
			return emitBase();
		} catch (error: unknown) {
			if (pending === undefined) throw error;
			pending.reject(error);
			socket.destroy();
			return true;
		}
	}

	override listen(...args: unknown[]): this {
		const normalized = normalizeListenArgs(args);
		let port = 0;
		if (
			typeof normalized.port === "number" ||
			typeof normalized.port === "string"
		) {
			port = validatePort(normalized.port, "options.port");
		}
		if (this.#port != null || portMapper.has(port)) {
			throw new ERR_SERVER_ALREADY_LISTEN();
		}
		if (normalized.callback !== undefined) {
			this.once("listening", normalized.callback);
		}
		this.#port = findSuitablePort(port);
		portMapper.set(this.#port, {
			fetch: (request: Request, env?: unknown, ctx?: unknown) =>
				dispatchToServer(this, request, env, ctx),
		});
		queueMicrotask(() => this.emit("listening"));
		return this;
	}

	override close(callback?: (error?: Error) => void): this {
		if (this.#port != null) {
			portMapper.delete(this.#port);
			this.#port = null;
		}
		if (typeof callback === "function") this.once("close", callback);
		queueMicrotask(() => this.emit("close"));
		return this;
	}

	override address(): AddressInfo | null {
		if (this.#port == null) return null;
		return { address: "127.0.0.1", family: "IPv4", port: this.#port };
	}

	override ref(): this {
		return this;
	}

	override unref(): this {
		return this;
	}

	override getConnections(
		callback?: (error: Error | null, count: number) => void,
	): this {
		if (callback !== undefined) queueMicrotask(() => callback(null, 0));
		return this;
	}
}

Object.defineProperty(Server.prototype, "listening", {
	configurable: true,
	get(this: Server): boolean {
		return this.address() !== null;
	},
});

export function createServer(
	options?: http.ServerOptions | http.RequestListener,
	requestListener?: http.RequestListener,
): Server {
	return typeof options === "function"
		? new Server(options)
		: new Server(options ?? {}, requestListener);
}

export default { ...http, ClientRequest, Server, createServer, get, request };
