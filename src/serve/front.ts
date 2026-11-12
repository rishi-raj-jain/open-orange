import { createHmac, timingSafeEqual } from "node:crypto";
import { createServer, request as httpRequest, type IncomingMessage, type Server } from "node:http";
import { connect, type Socket } from "node:net";

import type { RouteTable } from "./routes.js";

/** Headers that an Orange forwarder sets to serve another host through this cluster. */
export const forwardedHostHeader = "x-orange-forwarded-host";
export const forwardedHostSignatureHeader = "x-orange-forwarded-host-signature";
/** The shared secret that signs forwarded hosts. Unset, forwarded hosts are ignored. */
export const forwardedHostSecretVariable = "ORANGE_FORWARDED_HOST_SECRET";

export function signForwardedHost(secret: string, host: string): string {
	return createHmac("sha256", secret).update(host.toLowerCase()).digest("hex");
}

export interface FrontTarget {
	port: number;
}

export interface FrontOptions {
	host: string;
	port: number;
	/** The Worker for requests that match no route: the first Worker of `orange serve`. */
	fallback: () => FrontTarget;
	routes: RouteTable<() => FrontTarget>;
	forwardedHostSecret?: string;
}

export interface RunningFront {
	host: string;
	port: number;
	close(): Promise<void>;
}

// The host a request is for. A forwarder that holds the secret can name another host,
// as a custom domain does on Cloudflare. Both forwarding headers never reach a Worker.
function requestHost(request: IncomingMessage, secret: string | undefined): string {
	const forwarded = request.headers[forwardedHostHeader];
	const signature = request.headers[forwardedHostSignatureHeader];
	delete request.headers[forwardedHostHeader];
	delete request.headers[forwardedHostSignatureHeader];
	const own = request.headers.host ?? "";
	if (secret === undefined || typeof forwarded !== "string" || typeof signature !== "string") return own;
	const expected = Buffer.from(signForwardedHost(secret, forwarded));
	const given = Buffer.from(signature);
	return expected.length === given.length && timingSafeEqual(expected, given) ? forwarded : own;
}

// Request headers for the Worker: the original raw headers, with the routed host.
function forwardedHeaders(request: IncomingMessage, host: string): string[] {
	const headers: string[] = [];
	let sawConnectingIp = false;
	for (let index = 0; index < request.rawHeaders.length; index += 2) {
		const name = request.rawHeaders[index] ?? "";
		const lower = name.toLowerCase();
		if (lower === "host" || lower === forwardedHostHeader || lower === forwardedHostSignatureHeader) continue;
		if (lower === "cf-connecting-ip") sawConnectingIp = true;
		headers.push(name, request.rawHeaders[index + 1] ?? "");
	}
	headers.unshift("Host", host);
	// The Worker runtime sets cf-connecting-ip from its socket, which is now this front.
	const address = request.socket.remoteAddress;
	if (!sawConnectingIp && address !== undefined) {
		headers.push("cf-connecting-ip", address.startsWith("::ffff:") ? address.slice(7) : address);
	}
	return headers;
}

function targetFor(options: FrontOptions, host: string, path: string): FrontTarget {
	return (options.routes.match(host, path) ?? options.fallback)();
}

/** Listens on the serve port and passes each request and WebSocket to the Worker its route names. */
export async function startFront(options: FrontOptions): Promise<RunningFront> {
	const server: Server = createServer((request, response) => {
		const host = requestHost(request, options.forwardedHostSecret);
		const target = targetFor(options, host, request.url ?? "/");
		const upstream = httpRequest({
			headers: forwardedHeaders(request, host),
			host: "127.0.0.1",
			method: request.method,
			path: request.url,
			port: target.port,
		});
		upstream.on("response", (answer) => {
			response.writeHead(answer.statusCode ?? 502, answer.statusMessage, answer.rawHeaders);
			answer.pipe(response);
		});
		upstream.on("error", () => {
			if (!response.headersSent) response.writeHead(502, { "content-type": "text/plain" });
			response.end("Bad gateway");
		});
		response.on("close", () => {
			if (!response.writableFinished) upstream.destroy();
		});
		request.pipe(upstream);
	});
	server.on("upgrade", (request: IncomingMessage, socket: Socket, head: Buffer) => {
		const host = requestHost(request, options.forwardedHostSecret);
		const target = targetFor(options, host, request.url ?? "/");
		const upstream = connect(target.port, "127.0.0.1", () => {
			const headers = forwardedHeaders(request, host);
			let lines = `${request.method ?? "GET"} ${request.url ?? "/"} HTTP/1.1\r\n`;
			for (let index = 0; index < headers.length; index += 2) lines += `${headers[index]}: ${headers[index + 1]}\r\n`;
			upstream.write(`${lines}\r\n`);
			if (head.length > 0) upstream.write(head);
			upstream.pipe(socket);
			socket.pipe(upstream);
		});
		const close = (): void => {
			socket.destroy();
			upstream.destroy();
		};
		upstream.on("error", close);
		socket.on("error", close);
		upstream.on("close", () => socket.destroy());
		socket.on("close", () => upstream.destroy());
	});
	await new Promise<void>((resolveListen, rejectListen) => {
		server.once("error", rejectListen);
		server.listen(options.port, options.host, () => {
			server.off("error", rejectListen);
			resolveListen();
		});
	});
	const address = server.address();
	const port = typeof address === "object" && address !== null ? address.port : options.port;
	return {
		host: options.host,
		port,
		close: () =>
			new Promise<void>((resolveClose) => {
				server.closeAllConnections();
				server.close(() => resolveClose());
			}),
	};
}
