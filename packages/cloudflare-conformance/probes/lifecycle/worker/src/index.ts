import { DurableObject, WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from "cloudflare:workers";

export class Room extends DurableObject {
	#count = 0;

	override async fetch(request: Request): Promise<Response> {
		const url = new URL(request.url);
		switch (url.pathname) {
			case "/put":
				await this.ctx.storage.put("value", url.searchParams.get("value"));
				return Response.json({ ok: true });
			case "/get":
				return Response.json({ value: (await this.ctx.storage.get("value")) ?? null });
			case "/alarm":
				await this.ctx.storage.setAlarm(Date.now() + Number(url.searchParams.get("ms")));
				return Response.json({ ok: true });
			case "/closed":
				return Response.json({ code: (await this.ctx.storage.get("closed")) ?? null });
			case "/fired":
				return Response.json({ fired: (await this.ctx.storage.get("fired")) ?? 0 });
			case "/ws": {
				const pair = new WebSocketPair();
				this.ctx.acceptWebSocket(pair[1]);
				return new Response(null, { status: 101, webSocket: pair[0] });
			}
			default:
				return new Response("not found", { status: 404 });
		}
	}

	override async alarm(): Promise<void> {
		const fired = ((await this.ctx.storage.get<number>("fired")) ?? 0) + 1;
		await this.ctx.storage.put("fired", fired);
		// The log shows that it fired without a request waking the object.
		console.log(`lifecycle-alarm-fired ${fired}`);
	}

	override webSocketMessage(socket: WebSocket, message: string | ArrayBuffer): void {
		if (message === "bye") {
			socket.close(1000, "bye");
			return;
		}
		if (message === "count") {
			this.#count++;
			socket.send(`count:${this.#count}`);
			return;
		}
		socket.send(`echo:${String(message)}`);
	}

	override async webSocketClose(_socket: WebSocket, code: number): Promise<void> {
		await this.ctx.storage.put("closed", code);
	}
}

// A class from a `new_classes` migration: KV-backed on Cloudflare.
export class Legacy extends DurableObject {
	override async fetch(request: Request): Promise<Response> {
		const url = new URL(request.url);
		if (url.pathname === "/legacy/put") await this.ctx.storage.put("value", "kept");
		if (url.pathname === "/legacy/sql") {
			try {
				return Response.json({ rows: this.ctx.storage.sql.exec("SELECT 1 AS v").toArray() });
			} catch (error) {
				return Response.json({ error: error instanceof Error ? error.message : String(error) });
			}
		}
		return Response.json({ value: (await this.ctx.storage.get("value")) ?? null });
	}
}

export class Flow extends WorkflowEntrypoint {
	override async run(event: WorkflowEvent<{ wait?: boolean }>, step: WorkflowStep): Promise<string> {
		const first = await step.do("first", async () => "first done");
		if (event.payload.wait === true) await step.waitForEvent("go", { type: "go", timeout: "1 hour" });
		return first;
	}
}

interface Env {
	ROOM: DurableObjectNamespace;
	LEGACY: DurableObjectNamespace;
	FLOW: Workflow;
}

export default {
	async fetch(request: Request, env: Env): Promise<Response> {
		const url = new URL(request.url);
		if (url.pathname.startsWith("/flow/")) {
			const [, , action = "", id = ""] = url.pathname.split("/");
			try {
				switch (action) {
					case "start":
						await env.FLOW.create({ id, params: { wait: url.searchParams.has("wait") } });
						return Response.json({ id });
					case "status":
						return Response.json(await (await env.FLOW.get(id)).status());
					case "event":
						await (await env.FLOW.get(id)).sendEvent({ type: "go", payload: {} });
						return Response.json({ ok: true });
					case "pause":
					case "resume":
					case "terminate":
					case "restart":
						await (await env.FLOW.get(id))[action]();
						return Response.json({ ok: true });
					default:
						return new Response("not found", { status: 404 });
				}
			} catch (error) {
				return Response.json({ error: error instanceof Error ? error.message : String(error) }, { status: 500 });
			}
		}
		if (url.pathname.startsWith("/legacy/")) return env.LEGACY.get(env.LEGACY.idFromName("legacy")).fetch(request);
		const name = url.searchParams.get("room") ?? "main";
		return env.ROOM.get(env.ROOM.idFromName(name)).fetch(request);
	},
};
