import { DurableObject } from "cloudflare:workers";

interface Env {
	COUNTER: DurableObjectNamespace<Counter>;
}

// One shared counter. Every connected client sees every change.
export class Counter extends DurableObject<Env> {
	sockets = new Set<WebSocket>();
	value: number;

	constructor(ctx: DurableObjectState, env: Env) {
		super(ctx, env);
		this.value = ctx.storage.kv.get<number>("value") ?? 0;
	}

	async fetch(): Promise<Response> {
		const [client, server] = Object.values(new WebSocketPair());
		// A standard WebSocket keeps the object in memory while it is open.
		server.accept();
		this.sockets.add(server);
		server.addEventListener("message", (event) => this.onCommand(server, event.data));
		server.addEventListener("close", () => this.sockets.delete(server));
		server.send(JSON.stringify({ value: this.value }));
		return new Response(null, { status: 101, webSocket: client });
	}

	onCommand(socket: WebSocket, command: unknown): void {
		const change = command === "increment" ? 1 : command === "decrement" ? -1 : 0;
		if (change === 0) {
			socket.send(JSON.stringify({ error: `Unknown command: ${String(command)}` }));
			return;
		}
		this.value += change;
		// The SQLite-backed storage API is synchronous, so updates stay in order.
		this.ctx.storage.kv.put("value", this.value);
		const update = JSON.stringify({ value: this.value });
		for (const client of this.sockets) client.send(update);
	}
}

export default {
	async fetch(request, env): Promise<Response> {
		const name = /^\/counters\/([\w-]+)$/.exec(new URL(request.url).pathname)?.[1];
		if (name === undefined) {
			return new Response("Connect to /counters/<name>", { status: 404 });
		}
		if (request.headers.get("Upgrade") !== "websocket") {
			return new Response("Expected a WebSocket upgrade", { status: 426 });
		}
		return env.COUNTER.getByName(name).fetch(request);
	},
} satisfies ExportedHandler<Env>;
