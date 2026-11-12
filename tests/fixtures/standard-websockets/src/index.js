import { DurableObject } from "cloudflare:workers";

export class Room extends DurableObject {
	boot = crypto.randomUUID();
	sockets = new Map();

	async fetch(request) {
		const url = new URL(request.url);
		if (url.pathname === "/boot") return new Response(this.boot);
		if (url.pathname === "/close") {
			for (const socket of this.sockets.values()) socket.close(1000, "closed by the object");
			return new Response("closed");
		}
		if (url.pathname === "/close-in-alarm") {
			await this.ctx.storage.setAlarm(Date.now() + 500);
			return new Response("scheduled");
		}
		const pair = new WebSocketPair();
		if (url.searchParams.has("accepted")) {
			this.ctx.acceptWebSocket(pair[1]);
		} else {
			const name = url.searchParams.get("name");
			pair[1].accept();
			this.sockets.set(name, pair[1]);
			pair[1].addEventListener("close", () => this.sockets.delete(name));
			pair[1].addEventListener("message", (event) => pair[1].send(`${this.boot}:${event.data}`));
		}
		return new Response(null, { status: 101, webSocket: pair[0] });
	}

	alarm() {
		this.sockets.get("first")?.close(1011);
	}
}

export default {
	fetch(request, env) {
		return env.ROOM.getByName(new URL(request.url).searchParams.get("room")).fetch(request);
	},
};
