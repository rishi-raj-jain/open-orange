import { DurableObject } from "cloudflare:workers";
import { setTimeout as nodeSetTimeout } from "node:timers";
import { setInterval as every, setTimeout as wait } from "node:timers/promises";

export class Room extends DurableObject {
	boot = crypto.randomUUID();
	bornAt = Date.now();
	// In-memory only, so it starts again in each instance.
	messages = 0;

	constructor(ctx, env) {
		super(ctx, env);
		this.constructedWith = ctx.getWebSockets().length;
		ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair("ping", "pong"));
	}

	async fetch(request) {
		const url = new URL(request.url);
		if (url.pathname === "/boot") return new Response(this.boot);
		// A pending timer, longer than the 10 second idle timeout, on an object with no WebSocket.
		if (url.pathname === "/arm-timer") {
			setTimeout(() => this.ctx.storage.put("timerFiredBy", this.boot), 14_000);
			return new Response(this.boot);
		}
		// The same 14 second timer from node:timers, from node:timers/promises, or as five 3 second
		// ticks of a node:timers/promises interval.
		if (url.pathname === "/arm-node-timer") {
			const fired = () => this.ctx.storage.put("timerFiredBy", this.boot);
			const kind = url.searchParams.get("kind");
			if (kind === "callback") nodeSetTimeout(fired, 14_000);
			if (kind === "promise") void wait(14_000).then(fired);
			if (kind === "interval") {
				void (async () => {
					let ticks = 0;
					for await (const _ of every(3_000)) if (++ticks === 5) break;
					await fired();
				})();
			}
			return new Response(this.boot);
		}
		if (url.pathname === "/timer-fired-by") {
			return new Response((await this.ctx.storage.get("timerFiredBy")) ?? "");
		}
		if (url.pathname === "/closed") return Response.json((await this.ctx.storage.get("closed")) ?? []);
		if (url.pathname === "/close-all") {
			for (const socket of this.ctx.getWebSockets()) socket.close(4000, "closed by the object");
			return new Response("closed");
		}
		const pair = new WebSocketPair();
		if (url.searchParams.get("mode") === "standard") {
			// A standard WebSocket, which keeps the object awake while it is open.
			pair[1].accept();
			pair[1].addEventListener("message", (event) => pair[1].send(String(event.data)));
			return new Response(null, { status: 101, webSocket: pair[0] });
		}
		const name = url.searchParams.get("name");
		this.ctx.acceptWebSocket(pair[1], [name, "everyone"]);
		pair[1].serializeAttachment({ name });
		return new Response(null, { status: 101, webSocket: pair[0] });
	}

	async webSocketMessage(socket, message) {
		if (message === "close-me") {
			socket.close(4001, "closed on request");
			return;
		}
		const { name } = socket.deserializeAttachment();
		// A pending timer, longer than the 10 second idle timeout.
		if (message === "arm-timer") {
			setTimeout(() => this.ctx.storage.put("timerFiredBy", this.boot), 14_000);
		}
		// A WebSocket that the object opens to another server and keeps open.
		if (message.startsWith("open-outbound ")) {
			this.outbound = new WebSocket(message.slice("open-outbound ".length));
			await new Promise((resolve) => this.outbound.addEventListener("open", resolve, { once: true }));
		}
		if (message === "close-outbound") this.outbound.close(1000, "done");
		// A WebSocket that the object opens to another object through a stub.
		if (message === "open-stub-socket") {
			const response = await this.env.ROOM.getByName("stub-peer").fetch("http://peer/socket?mode=standard", {
				headers: { Upgrade: "websocket" },
			});
			this.stubSocket = response.webSocket;
			this.stubSocket.accept();
		}
		if (message === "close-stub-socket") this.stubSocket.close(1000, "done");
		// A request that nothing awaits.
		if (message.startsWith("fetch-unawaited ")) {
			void fetch(message.slice("fetch-unawaited ".length)).then(() =>
				this.ctx.storage.put("fetchDoneBy", this.boot),
			);
		}
		if (message === "arm-unref-timer") {
			setTimeout(() => this.ctx.storage.put("timerFiredBy", this.boot), 14_000).unref();
		}
		// Background work that runs until "release-wait-until".
		if (message === "hold-wait-until") {
			this.ctx.waitUntil(new Promise((resolve) => (this.releaseWaitUntil = resolve)));
		}
		if (message === "release-wait-until") this.releaseWaitUntil?.();
		// An interval that runs until "clear-interval".
		if (message === "arm-interval") this.interval = setInterval(() => {}, 3_000);
		if (message === "clear-interval") clearInterval(this.interval);
		// An interval that logs, and a reset of the object.
		if (message === "log-ticks") setInterval(() => console.log(`tick from ${this.boot}`), 200);
		if (message === "abort") this.ctx.abort("reset by the test");
		// A handler that runs for longer than the 10 second idle timeout.
		if (message === "slow-event") await new Promise((resolve) => setTimeout(resolve, 12_000));
		const count = ((await this.ctx.storage.get("count")) ?? 0) + 1;
		await this.ctx.storage.put("count", count);
		socket.send(
			JSON.stringify({
				attachment: name,
				autoResponseAt: this.ctx.getWebSocketAutoResponseTimestamp(socket)?.getTime() ?? null,
				boot: this.boot,
				bornAt: this.bornAt,
				constructedWith: this.constructedWith,
				count,
				everyone: this.ctx.getWebSockets("everyone").length,
				fetchDoneBy: (await this.ctx.storage.get("fetchDoneBy")) ?? null,
				message,
				messages: ++this.messages,
				sameName: this.ctx.getWebSockets(name).length,
				tags: this.ctx.getTags(socket),
				timerFiredBy: (await this.ctx.storage.get("timerFiredBy")) ?? null,
			}),
		);
	}

	async webSocketClose(socket, code, reason) {
		const { name } = socket.deserializeAttachment();
		if (name === "throws") throw new Error("close handler failed");
		// Longer than the 10 second sleep timeout.
		if (name === "slow") await new Promise((resolve) => setTimeout(resolve, 13_000));
		const closed = (await this.ctx.storage.get("closed")) ?? [];
		closed.push({ code, name, reason });
		await this.ctx.storage.put("closed", closed);
	}
}

export default {
	fetch(request, env) {
		const url = new URL(request.url);
		return env.ROOM.getByName(url.searchParams.get("room") ?? "a").fetch(request);
	},
};
