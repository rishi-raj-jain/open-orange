import { newMessagePortRpcSession, RpcTarget as CapnWebTarget } from "capnweb";
import { DurableObject, RpcTarget, ServiceStub } from "cloudflare:workers";

class Inner extends RpcTarget {
	ping() {
		return "pong";
	}
}

export class Room extends DurableObject {
	open() {
		return new Inner();
	}

	label() {
		return "room";
	}
}

// A Worker's own Cap'n Web server hands out stubs that came from a Durable Object.
class Api extends CapnWebTarget {
	#env;

	constructor(env) {
		super();
		this.#env = env;
	}

	room() {
		return this.#env.ROOM.getByName("a");
	}

	open() {
		return this.#env.ROOM.getByName("a").open();
	}
}

export default {
	async fetch(_request, env) {
		const { port1, port2 } = new MessageChannel();
		newMessagePortRpcSession(port1, new Api(env));
		const client = newMessagePortRpcSession(port2);
		const settle = async (run) => {
			try {
				return await run();
			} catch (error) {
				return `rejected ${error.message}`;
			}
		};
		const returned = await settle(async () => await (await client.open()).ping());
		const object = await settle(async () => await client.room().label());
		const stub = env.ROOM.getByName("a");
		return Response.json({ returned, object, objectIsServiceStub: stub instanceof ServiceStub });
	},
};
