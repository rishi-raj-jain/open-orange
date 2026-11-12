import { DurableObject } from "cloudflare:workers";

// One idle object: one row of storage, one accepted socket or more, and nothing else.
export class Room extends DurableObject {
	boot = crypto.randomUUID();

	async fetch(request) {
		if (new URL(request.url).searchParams.get("kind") === "boot") return Response.json({ boot: this.boot });
		await this.ctx.storage.put("opened", ((await this.ctx.storage.get("opened")) ?? 0) + 1);
		const pair = new WebSocketPair();
		this.ctx.acceptWebSocket(pair[1]);
		return new Response(null, { status: 101, webSocket: pair[0] });
	}

	webSocketMessage(socket) {
		socket.send(JSON.stringify({ boot: this.boot, open: this.ctx.getWebSockets().length }));
	}
}

export default {
	fetch(request, env) {
		const url = new URL(request.url);
		if (url.pathname === "/") return Response.json({ ok: true });
		return env.ROOM.getByName(url.searchParams.get("room") ?? "room").fetch(request);
	},
};
