import { DurableObject } from "cloudflare:workers";

interface Env {
	ROOM: DurableObjectNamespace<Room>;
}

// The object closes its end with the code that the client sends.
export class Room extends DurableObject<Env> {
	fetch(): Response {
		const [client, server] = Object.values(new WebSocketPair());
		server.accept();
		server.addEventListener("message", (event) => {
			server.close(Number(event.data), "closed by the object");
		});
		return new Response(null, { status: 101, webSocket: client });
	}
}

export default {
	async fetch(request: Request, env: Env): Promise<Response> {
		return env.ROOM.getByName("room").fetch(request);
	},
};
