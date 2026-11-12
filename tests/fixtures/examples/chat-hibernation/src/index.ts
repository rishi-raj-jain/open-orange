import { DurableObject } from "cloudflare:workers";

interface Env {
	CHAT_ROOM: DurableObjectNamespace<ChatRoom>;
}

type ChatMessage = { from: string; text: string };

// Messages from a client: `{ "text": "hi" }` for the room, or add `"to": "bob"`
// for a direct message.
interface ClientMessage {
	text: string;
	to?: string;
}

export class ChatRoom extends DurableObject<Env> {
	constructor(ctx: DurableObjectState, env: Env) {
		super(ctx, env);
		ctx.storage.sql.exec(
			"CREATE TABLE IF NOT EXISTS messages (id INTEGER PRIMARY KEY, sender TEXT NOT NULL, text TEXT NOT NULL)",
		);
		// The runtime answers "ping" with "pong" without calling webSocketMessage().
		ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair("ping", "pong"));
	}

	async fetch(request: Request): Promise<Response> {
		const user = new URL(request.url).searchParams.get("user")!;
		const [client, server] = Object.values(new WebSocketPair());
		// acceptWebSocket() lets the object sleep while the socket stays open.
		// The tag lets the room find this user's sockets after it wakes up.
		this.ctx.acceptWebSocket(server, [user]);
		const history = this.ctx.storage.sql
			.exec<ChatMessage>(
				"SELECT sender AS \"from\", text FROM messages ORDER BY id",
			)
			.toArray();
		server.send(JSON.stringify({ type: "history", messages: history }));
		return new Response(null, { status: 101, webSocket: client });
	}

	// Runs in a fresh instance if the object slept since the last message.
	async webSocketMessage(ws: WebSocket, data: string | ArrayBuffer): Promise<void> {
		const [from] = this.ctx.getTags(ws);
		let message: ClientMessage;
		try {
			message = JSON.parse(String(data));
		} catch {
			ws.send(JSON.stringify({ type: "error", error: "Send JSON like {\"text\":\"hi\"}" }));
			return;
		}

		if (message.to !== undefined) {
			const recipients = this.ctx.getWebSockets(message.to);
			if (recipients.length === 0) {
				ws.send(JSON.stringify({ type: "error", error: `${message.to} is not in this room` }));
				return;
			}
			const direct = JSON.stringify({ type: "direct", from, text: message.text });
			for (const socket of recipients) socket.send(direct);
			return;
		}

		this.ctx.storage.sql.exec(
			"INSERT INTO messages (sender, text) VALUES (?, ?)",
			from,
			message.text,
		);
		const broadcast = JSON.stringify({ type: "message", from, text: message.text });
		for (const socket of this.ctx.getWebSockets()) socket.send(broadcast);
	}
}

export default {
	async fetch(request, env): Promise<Response> {
		const url = new URL(request.url);
		const room = /^\/rooms\/([\w-]+)$/.exec(url.pathname)?.[1];
		if (room === undefined) {
			return new Response("Connect to /rooms/<room>?user=<name>", { status: 404 });
		}
		if (request.headers.get("Upgrade") !== "websocket") {
			return new Response("Expected a WebSocket upgrade", { status: 426 });
		}
		if (!/^[\w-]{1,32}$/.test(url.searchParams.get("user") ?? "")) {
			return new Response("Set ?user= to 1-32 letters, digits, _ or -", { status: 400 });
		}
		return env.CHAT_ROOM.getByName(room).fetch(request);
	},
} satisfies ExportedHandler<Env>;
