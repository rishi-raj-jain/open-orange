import { DurableObject } from "cloudflare:workers";

interface Env {
	ROOM: DurableObjectNamespace<Room>;
}

// Counts constructions, so the test can tell that an object slept and woke.
const constructions = { Child: 0, Room: 0 };
const roomConstructions = new Map<string, number>();

export class Child extends DurableObject<Env> {
	constructor(ctx: DurableObjectState, env: Env) {
		super(ctx, env);
		constructions.Child += 1;
	}

	describe(): { constructions: number; name: string | null } {
		return { constructions: constructions.Child, name: this.ctx.id.name ?? null };
	}

	async wipe(): Promise<void> {
		await this.ctx.storage.deleteAll();
	}
}

export class Room extends DurableObject<Env> {
	constructor(ctx: DurableObjectState, env: Env) {
		super(ctx, env);
		constructions.Room += 1;
		const name = ctx.id.name ?? "";
		roomConstructions.set(name, (roomConstructions.get(name) ?? 0) + 1);
	}

	child() {
		return this.ctx.facets.get<Child>("child", () => ({ class: this.ctx.exports.Child }));
	}

	fetch(): Response {
		const [client, server] = Object.values(new WebSocketPair());
		this.ctx.acceptWebSocket(server);
		return new Response(null, { status: 101, webSocket: client });
	}

	webSocketMessage(socket: WebSocket, message: string | ArrayBuffer): void {
		socket.send(`echo:${String(message)}`);
	}

	// Settings are made after the constructor, so only stored settings survive a wake.
	async configure(): Promise<void> {
		this.ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair("ping", "pong"));
		this.ctx.setHibernatableWebSocketEventTimeout(5_000);
		this.ctx.storage.sql.exec("CREATE TABLE notes (text TEXT)");
		await this.child().wipe();
		await this.ctx.storage.deleteAll();
	}

	// Cloudflare keeps these settings outside storage, so a rolled-back transaction keeps them.
	async configureInRolledBackTransaction(kind: "async" | "sync"): Promise<void> {
		const configure = () => {
			this.ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair("ping", "pong"));
			this.ctx.setHibernatableWebSocketEventTimeout(5_000);
			throw new Error("roll back");
		};
		try {
			if (kind === "sync") this.ctx.storage.transactionSync(configure);
			else await this.ctx.storage.transaction(async () => configure());
		} catch (error) {
			if (!(error instanceof Error) || error.message !== "roll back") throw error;
		}
	}

	settings() {
		return {
			autoResponse: this.ctx.getWebSocketAutoResponse()?.response ?? null,
			constructions: roomConstructions.get(this.ctx.id.name ?? "") ?? 0,
			eventTimeout: this.ctx.getHibernatableWebSocketEventTimeout(),
		};
	}

	async read() {
		// RPC results carry a disposer, so copy the fields.
		const { constructions: childConstructions, name: childName } = await this.child().describe();
		return {
			autoResponse: this.ctx.getWebSocketAutoResponse()?.response ?? null,
			child: { constructions: childConstructions, name: childName },
			constructions: constructions.Room,
			eventTimeout: this.ctx.getHibernatableWebSocketEventTimeout(),
			name: this.ctx.id.name ?? null,
			tables: this.ctx.storage.sql
				.exec<{ name: string }>("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE '\\_%' ESCAPE '\\'")
				.toArray()
				.map((row) => row.name),
		};
	}
}

export default {
	async fetch(request: Request, env: Env): Promise<Response> {
		const url = new URL(request.url);
		const room = env.ROOM.getByName(url.searchParams.get("room") ?? "lobby");
		if (url.pathname === "/socket") return room.fetch(request);
		const rollback = url.searchParams.get("rollback");
		if (url.pathname === "/configure" && (rollback === "async" || rollback === "sync")) {
			await room.configureInRolledBackTransaction(rollback);
			return new Response(null, { status: 204 });
		}
		if (url.pathname === "/settings") return Response.json(await room.settings());
		if (url.pathname === "/configure") {
			await room.configure();
			return new Response(null, { status: 204 });
		}
		return Response.json(await room.read());
	},
};
