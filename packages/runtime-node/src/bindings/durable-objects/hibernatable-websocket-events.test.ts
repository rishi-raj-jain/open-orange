import assert from "node:assert/strict";
import test from "node:test";

import {
	WebSocketPair,
	WebSocketRequestResponsePair,
} from "../../globals/websocket.js";
import { DurableObject } from "../../modules/cloudflare-workers/durable-object.js";
import { createHibernatableWebSocketIncomingHandlers } from "./hibernatable-websocket-events.js";
import { createDurableObjectGeneration } from "./state.js";

function eventProperty(event: unknown, name: string): unknown {
	return typeof event === "object" && event !== null
		? Reflect.get(event, name)
		: undefined;
}

function nextEvent(type: string, socket: WebSocketPair[0]): Promise<unknown> {
	return new Promise((resolve) => socket.addEventListener(type, resolve));
}

test("dispatches optional hibernatable methods and consumes one terminal event", async () => {
	const events: string[] = [];
	class SocketRoom extends DurableObject {
		webSocketMessage(): void {
			events.push("message");
		}

		async webSocketError(): Promise<void> {
			await Promise.resolve();
			events.push("error");
		}

		webSocketClose(): void {
			events.push("close");
		}
	}
	const generation = createDurableObjectGeneration({
		bindings: {},
		className: "SocketRoom",
		userClass: SocketRoom,
	});
	const pair = new WebSocketPair();
	generation.state.acceptWebSocket(pair[1], ["room"]);
	const handlers = createHibernatableWebSocketIncomingHandlers(
		generation,
		pair[1],
	);

	await handlers.message("hello");
	await handlers.error(new Error("transport failed"));
	await handlers.close(1006, "closed", false);
	await handlers.message("late");

	assert.deepEqual(events, ["message", "error"]);
	assert.deepEqual(generation.state.getWebSockets(), []);
});

test("silently consumes hibernatable events when methods are absent", async () => {
	class SocketRoom extends DurableObject {}
	const generation = createDurableObjectGeneration({
		bindings: {},
		className: "SocketRoom",
		userClass: SocketRoom,
	});
	const pair = new WebSocketPair();
	generation.state.acceptWebSocket(pair[1]);
	const handlers = createHibernatableWebSocketIncomingHandlers(
		generation,
		pair[1],
	);

	await handlers.message(new ArrayBuffer(0));
	await handlers.close(1000, "", true);
	assert.deepEqual(generation.state.getWebSockets(), []);
});

test("times out asynchronous hibernatable event methods", async () => {
	let timedOut = 0;
	class SocketRoom extends DurableObject {
		webSocketMessage(): Promise<void> {
			return new Promise(() => undefined);
		}
	}
	const generation = createDurableObjectGeneration({
		bindings: {},
		className: "SocketRoom",
		userClass: SocketRoom,
	});
	generation.state.setHibernatableWebSocketEventTimeout(5);
	const pair = new WebSocketPair();
	generation.state.acceptWebSocket(pair[1]);
	const handlers = createHibernatableWebSocketIncomingHandlers(
		generation,
		pair[1],
		{ onEventTimeout: () => timedOut++ },
	);

	await assert.rejects(
		Promise.resolve(handlers.message("slow")),
		/Actor exceeded event execution time and was disconnected/,
	);
	assert.equal(timedOut, 1);
});
