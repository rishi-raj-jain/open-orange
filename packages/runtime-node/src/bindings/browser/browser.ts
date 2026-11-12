import { randomUUID } from "node:crypto";
import { createRequire } from "node:module";

import { fetch as hostFetch } from "undici";

import { Request, Response } from "../../globals/http.js";
import { coupleWebSocket, WebSocketPair, type WebSocketTransport } from "../../globals/websocket.js";
import type { RuntimeSettings } from "../../internal/runtime-settings.js";
import { isRecord } from "../unknown-values.js";

// A Browser Rendering binding talks to a Chrome that the user runs, through its DevTools Protocol
// endpoint: `ws://host:9222/devtools/browser/<id>`, or `http://host:9222`, which Orange asks for
// that address at `/json/version`.
export const browserCdpSetting = "ORANGE_BROWSER_CDP_URL";

// The `ws` client exports that this binding uses. Orange does not depend on @types/ws.
interface WsClient {
	addEventListener(type: string, listener: (event: unknown) => void): void;
	binaryType: "arraybuffer" | "blob" | "nodebuffer" | "fragments";
	close(code?: number, reason?: string): void;
	readonly readyState: number;
	removeEventListener(type: string, listener: (event: unknown) => void): void;
	send(data: string | ArrayBufferLike | ArrayBufferView): void;
	terminate(): void;
}
type WsClientConstructor = new (url: string, options: { perMessageDeflate: false }) => WsClient;

// SAFETY: `ws` is a pinned dependency whose WebSocket matches WsClient. require() is untyped.
const { WebSocket: WsWebSocket } = createRequire(import.meta.url)("ws") as { WebSocket: WsClientConstructor };

interface Session {
	connectionId: string | undefined;
	endTime?: number;
	sessionId: string;
	startTime: number;
}

// Chrome reports its own address, such as 127.0.0.1 inside a container, so the reported path
// is kept and the configured host is used.
async function browserWebSocketUrl(configured: string): Promise<string> {
	const url = new URL(configured);
	if (url.protocol === "ws:" || url.protocol === "wss:") return url.href;
	if (url.protocol !== "http:" && url.protocol !== "https:") {
		throw new Error(`${browserCdpSetting} must start with ws://, wss://, http://, or https://`);
	}
	const response = await hostFetch(new URL("/json/version", url), { signal: AbortSignal.timeout(10_000) });
	if (!response.ok) throw new Error(`/json/version answered HTTP ${response.status}`);
	const version: unknown = await response.json();
	const reported = isRecord(version) ? version.webSocketDebuggerUrl : undefined;
	if (typeof reported !== "string") throw new Error("/json/version has no webSocketDebuggerUrl");
	const socket = new URL(reported);
	socket.protocol = url.protocol === "https:" ? "wss:" : "ws:";
	socket.host = url.host;
	return socket.href;
}

// A hosted browser takes its key in the endpoint, as in `wss://connect.browserbase.com?apiKey=...`.
// An error that the Worker can read names the endpoint without its user info, query, or fragment,
// and any of those values in a library's own message, which can quote the URL, are redacted.
function endpointForErrors(configured: string): { endpoint: string; secrets: string[] } {
	let url: URL;
	try {
		url = new URL(configured);
	} catch {
		return { endpoint: browserCdpSetting, secrets: [configured] };
	}
	const raw = [url.search.slice(1), url.hash.slice(1)].flatMap((part) =>
		part.split("&").flatMap((pair) => pair.split("=").slice(1)),
	);
	const secrets = [url.username, url.password, ...url.searchParams.values(), ...raw, configured]
		.filter((value) => value.length > 0)
		// Longest first, so a value inside another is not redacted halfway.
		.sort((left, right) => right.length - left.length);
	return { endpoint: `${url.protocol}//${url.host}${url.pathname === "/" ? "" : url.pathname}`, secrets };
}

function errorMessage(error: unknown, secrets: readonly string[]): string {
	let message = error instanceof Error ? error.message : String(error);
	for (const secret of secrets) message = message.split(secret).join("<redacted>");
	return message;
}

function openSocket(url: string): Promise<WsClient> {
	return new Promise((resolveOpen, rejectOpen) => {
		const socket = new WsWebSocket(url, { perMessageDeflate: false });
		const onOpen = (): void => {
			socket.removeEventListener("error", onError);
			resolveOpen(socket);
		};
		const onError = (event: unknown): void => {
			socket.removeEventListener("open", onOpen);
			const error = isRecord(event) ? event.error : undefined;
			rejectOpen(error instanceof Error ? error : new Error(String(isRecord(event) ? event.message : event)));
		};
		socket.addEventListener("open", onOpen);
		socket.addEventListener("error", onError);
	});
}

// The CDP connection of one session. A Worker shares the configured Chrome with other sessions,
// so `Browser.close` closes only the pages that this session opened, and so does the end of the
// session. Everything else passes through as it is.
class CdpSessionTransport implements WebSocketTransport {
	readonly #socket: WsClient;
	readonly #targets = new Set<string>();
	readonly #creating = new Set<number>();
	readonly #listeners = new Map<string, Set<(event: unknown) => void | Promise<void>>>();
	#ended = false;
	#onEnd: () => void;

	constructor(socket: WsClient, onEnd: () => void) {
		this.#socket = socket;
		this.#onEnd = onEnd;
		socket.addEventListener("message", (event) => {
			const data = isRecord(event) ? event.data : undefined;
			if (typeof data === "string") this.#observe(data);
			this.#emit("message", event);
		});
		socket.addEventListener("close", (event) => {
			this.#end();
			this.#emit("close", event);
		});
		socket.addEventListener("error", (event) => this.#emit("error", event));
	}

	get binaryType(): "arraybuffer" | "blob" {
		return "arraybuffer";
	}

	set binaryType(_value: "arraybuffer" | "blob") {}

	get readyState(): number {
		return this.#socket.readyState;
	}

	addEventListener(type: string, listener: (event: unknown) => void | Promise<void>): void {
		let listeners = this.#listeners.get(type);
		if (listeners === undefined) {
			listeners = new Set();
			this.#listeners.set(type, listeners);
		}
		listeners.add(listener);
	}

	removeEventListener(type: string, listener: (event: unknown) => void | Promise<void>): void {
		this.#listeners.get(type)?.delete(listener);
	}

	send(data: string | ArrayBufferLike | Blob | ArrayBufferView): void {
		if (typeof data === "string") {
			const command = parseCommand(data);
			if (command?.method === "Browser.close") {
				// End only this session, at once, so sessions() no longer lists it, then answer as
				// Chrome would.
				this.#end();
				this.#emit("message", { data: JSON.stringify({ id: command.id, result: {}, ...(command.sessionId === undefined ? {} : { sessionId: command.sessionId }) }) });
				this.close(1000, "Browser.close");
				return;
			}
			if (command?.method === "Target.createTarget" && typeof command.id === "number") this.#creating.add(command.id);
			this.#socket.send(data);
			return;
		}
		this.#socket.send(data as ArrayBufferLike | ArrayBufferView);
	}

	close(code?: number, reason?: string): void {
		this.#closeTargets();
		this.#socket.close(code, reason);
	}

	terminate(): void {
		this.#closeTargets();
		this.#socket.terminate();
	}

	#observe(data: string): void {
		if (this.#creating.size === 0) return;
		const reply = parseCommand(data);
		if (reply === undefined || typeof reply.id !== "number" || !this.#creating.delete(reply.id)) return;
		const targetId = isRecord(reply.result) ? reply.result.targetId : undefined;
		if (typeof targetId === "string") this.#targets.add(targetId);
	}

	#closeTargets(): void {
		if (this.#socket.readyState !== 1) return;
		let id = 2_000_000_000;
		for (const targetId of this.#targets) {
			this.#socket.send(JSON.stringify({ id: id++, method: "Target.closeTarget", params: { targetId } }));
		}
		this.#targets.clear();
	}

	#end(): void {
		if (this.#ended) return;
		this.#ended = true;
		this.#onEnd();
	}

	#emit(type: string, event: unknown): void {
		for (const listener of this.#listeners.get(type) ?? []) void listener(event);
	}
}

function parseCommand(data: string): Record<string, unknown> | undefined {
	try {
		const parsed: unknown = JSON.parse(data);
		return isRecord(parsed) ? parsed : undefined;
	} catch {
		return undefined;
	}
}

const maximumSessions = 10;

// `env.BROWSER`. It answers the requests that `@cloudflare/puppeteer` sends to Browser Rendering:
// acquire a session, open its DevTools WebSocket, and list sessions, history, and limits.
// https://github.com/cloudflare/puppeteer/blob/main/packages/puppeteer-core/src/cloudflare/PuppeteerWorkers.ts
export class BrowserRendering {
	readonly #configured: string;
	readonly #endpoint: string;
	readonly #secrets: readonly string[];
	readonly #sessions = new Map<string, Session>();
	readonly #history: Session[] = [];

	constructor(configured: string) {
		this.#configured = configured;
		const { endpoint, secrets } = endpointForErrors(configured);
		this.#endpoint = endpoint;
		this.#secrets = secrets;
	}

	async fetch(input: Request | URL | string, init?: RequestInit): Promise<Response> {
		const request = new Request(input as never, init as never);
		const url = new URL(request.url);
		const path = url.pathname.replace(/\/+$/, "");
		if (path === "/v1/sessions") {
			return Response.json({ sessions: [...this.#sessions.values()].map(sessionRecord) });
		}
		if (path === "/v1/history") return Response.json({ history: this.#history.map(sessionRecord) });
		if (path === "/v1/limits") {
			return Response.json({
				activeSessions: [...this.#sessions.keys()].map((id) => ({ id })),
				allowedBrowserAcquisitions: Math.max(0, maximumSessions - this.#sessions.size),
				maxConcurrentSessions: maximumSessions,
				timeUntilNextAllowedBrowserAcquisition: 0,
			});
		}
		const upgrade = request.headers.get("upgrade")?.toLowerCase() === "websocket";
		if (path === "/v1/devtools/browser" && request.method === "POST" && !upgrade) {
			const reachable = await this.#reach();
			if (reachable instanceof Response) return reachable;
			return Response.json({ sessionId: this.#start().sessionId });
		}
		if (path === "/v1/devtools/browser" && upgrade) return await this.#connect(this.#start());
		const match = /^\/v1\/devtools\/browser\/([^/]+)$/.exec(path);
		if (match !== null && upgrade) {
			const session = this.#sessions.get(decodeURIComponent(match[1] ?? ""));
			if (session === undefined) return new Response("Browser Rendering session not found", { status: 404 });
			if (session.connectionId !== undefined) return new Response("Browser Rendering session is already in use", { status: 409 });
			return await this.#connect(session);
		}
		return new Response(`Browser Rendering on Orange has no route ${request.method} ${url.pathname}`, { status: 404 });
	}

	async #reach(): Promise<string | Response> {
		try {
			return await browserWebSocketUrl(this.#configured);
		} catch (error: unknown) {
			return new Response(
				`Browser Rendering could not reach the browser at ${this.#endpoint} (${browserCdpSetting}): ${errorMessage(error, this.#secrets)}`,
				{ status: 503 },
			);
		}
	}

	#start(): Session {
		const session: Session = { connectionId: undefined, sessionId: randomUUID(), startTime: Date.now() };
		this.#sessions.set(session.sessionId, session);
		this.#history.unshift(session);
		this.#history.length = Math.min(this.#history.length, 100);
		return session;
	}

	#end(session: Session): void {
		session.endTime = Date.now();
		session.connectionId = undefined;
		this.#sessions.delete(session.sessionId);
	}

	async #connect(session: Session): Promise<Response> {
		const reachable = await this.#reach();
		if (reachable instanceof Response) {
			this.#end(session);
			return reachable;
		}
		let socket: WsClient;
		try {
			socket = await openSocket(reachable);
		} catch (error: unknown) {
			this.#end(session);
			return new Response(
				`Browser Rendering could not open the DevTools WebSocket at ${this.#endpoint}: ${errorMessage(error, this.#secrets)}`,
				{ status: 502 },
			);
		}
		session.connectionId = randomUUID();
		const pair = new WebSocketPair();
		coupleWebSocket(pair[1], new CdpSessionTransport(socket, () => this.#end(session)));
		return new Response(null, { status: 101, webSocket: pair[0] });
	}
}

function sessionRecord(session: Session): Record<string, unknown> {
	return {
		...(session.connectionId === undefined ? {} : { connectionId: session.connectionId }),
		...(session.endTime === undefined ? {} : { endTime: session.endTime }),
		sessionId: session.sessionId,
		startTime: session.startTime,
	};
}

export function browserFromSettings(settings: RuntimeSettings): BrowserRendering | undefined {
	const configured = settings[browserCdpSetting];
	return configured === undefined || configured.length === 0 ? undefined : new BrowserRendering(configured);
}
