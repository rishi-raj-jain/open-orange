import assert from "node:assert/strict";
import test from "node:test";

import {
	Headers as OrangeHeaders,
	Response as OrangeResponse,
} from "../../globals/http.js";
import { WebSocket, WebSocketPair } from "../../globals/websocket.js";
import { DurableObject } from "../../modules/cloudflare-workers/durable-object.js";
import type { RivetWebSocket } from "../../internal/rivetkit.js";
import {
	createLinkedTestWebSocketPair,
	type LinkedTestWebSocket,
} from "./rpc/test-websocket.js";
import { createDurableObjectGeneration } from "./state.js";
import {
	attachDurableObjectWebSocket,
	fetchDurableObjectWebSocketStub,
	prepareDurableObjectWebSocket,
} from "./websocket.js";
import { fakeRivetActorHandle } from "./test-actor-handle.js";

function eventProperty(event: unknown, name: string): unknown {
	return typeof event === "object" && event !== null
		? Reflect.get(event, name)
		: undefined;
}

function nextEvent(socket: WebSocket, type: string): Promise<unknown> {
	return new Promise((resolve) => {
		socket.addEventListener(type, resolve, { once: true });
	});
}

test("bridges an upgraded stub fetch through the awake Rivet actor", async () => {
	const observedRequests: Request[] = [];
	const actorErrors: unknown[] = [];
	const actorCloses: unknown[][] = [];
	class ChatRoom extends DurableObject {
		fetch(request: Request): OrangeResponse {
			observedRequests.push(request);
			if (new URL(request.url).pathname === "/reject") {
				return new OrangeResponse("Upgrade Required", {
					headers: { "x-do-rejection": "expected" },
					status: 426,
					statusText: "Upgrade Required",
				});
			}
			const pair = new WebSocketPair();
			pair[1].binaryType = "arraybuffer";
			pair[1].accept();
			pair[1].addEventListener("message", (event: unknown) => {
				const data = eventProperty(event, "data");
				if (
					typeof data === "string" ||
					data instanceof ArrayBuffer ||
					ArrayBuffer.isView(data)
				) {
					pair[1].send(data);
				}
			});
			pair[1].addEventListener("error", (event: unknown) => {
				actorErrors.push(eventProperty(event, "error"));
			});
			pair[1].addEventListener("close", (event: unknown) => {
				actorCloses.push([
					eventProperty(event, "code"),
					eventProperty(event, "reason"),
					eventProperty(event, "wasClean"),
				]);
			});
			return new OrangeResponse(null, {
				headers: new OrangeHeaders({ "x-orange-upgrade": "accepted" }),
				status: 101,
				statusText: "Switching Protocols",
				webSocket: pair[0],
			});
		}
	}

	const generation = createDurableObjectGeneration({
		bindings: {},
		className: "ChatRoom",
		userClass: ChatRoom,
	});
	let openedSockets = 0;
	let actorTransport: LinkedTestWebSocket | undefined;
	const handle = fakeRivetActorHandle({
		async fetch(request: Request): Promise<Response> {
			const response = await prepareDurableObjectWebSocket(generation, request);
			return new Response(response.body, {
				headers: [...response.headers],
				status: response.status,
				statusText: response.statusText,
			});
		},
		async webSocket(path: string) {
			openedSockets += 1;
			const [client, server] = createLinkedTestWebSocketPair();
			actorTransport = server;
			attachDurableObjectWebSocket(
				generation,
				new Request(new URL(path, "http://actor")),
				server,
			);
			return client;
		},
	});
	const request = new Request("https://worker.example/rooms/alpha?mode=chat", {
		headers: {
			connection: "Upgrade",
			upgrade: "websocket",
			"x-client-id": "client-one",
		},
	});
	const response = await fetchDurableObjectWebSocketStub(
		() => handle,
		request,
		{ key: "stub-one", sequence: 0 },
		new AbortController().signal,
	);

	assert.equal(response.status, 101);
	assert.equal(response.statusText, "Switching Protocols");
	assert.equal(response.headers.get("x-orange-upgrade"), "accepted");
	assert.equal(openedSockets, 1);
	assert.equal(observedRequests.length, 1);
	assert.equal(observedRequests[0]?.url, request.url);
	assert.equal(observedRequests[0]?.headers.get("x-client-id"), "client-one");

	const socket = response.webSocket;
	assert.ok(socket);
	socket.binaryType = "arraybuffer";
	socket.accept();

	const textEvent = nextEvent(socket, "message");
	socket.send("hello");
	assert.equal(eventProperty(await textEvent, "data"), "hello");

	const binaryEvent = nextEvent(socket, "message");
	socket.send(Uint8Array.of(4, 5, 6));
	const binary = eventProperty(await binaryEvent, "data");
	assert.ok(binary instanceof ArrayBuffer);
	assert.deepEqual([...new Uint8Array(binary)], [4, 5, 6]);

	const expectedError = new Error("fixture transport error");
	if (actorTransport === undefined) {
		throw new Error("Fixture did not open its actor transport");
	}
	actorTransport.emit("error", { error: expectedError });
	await actorTransport.flush();
	assert.deepEqual(actorErrors, [expectedError]);

	const closeEvent = nextEvent(socket, "close");
	socket.close(1000, "done");
	assert.equal(eventProperty(await closeEvent, "code"), 1000);

	const rejected = await fetchDurableObjectWebSocketStub(
		() => handle,
		new Request("https://worker.example/reject", {
			headers: { upgrade: "websocket" },
		}),
		{ key: "stub-one", sequence: 1 },
		new AbortController().signal,
	);
	assert.equal(rejected.status, 426);
	assert.equal(rejected.statusText, "Upgrade Required");
	assert.equal(rejected.headers.get("x-do-rejection"), "expected");
	assert.equal(await rejected.text(), "Upgrade Required");
	assert.equal(openedSockets, 1);

	const abruptlyClosed = await fetchDurableObjectWebSocketStub(
		() => handle,
		new Request("https://worker.example/socket?id=abrupt", {
			headers: { upgrade: "websocket" },
		}),
		{ key: "stub-one", sequence: 2 },
		new AbortController().signal,
	);
	abruptlyClosed.webSocket?.accept();
	if (actorTransport === undefined) {
		throw new Error("Fixture did not open its second actor transport");
	}
	actorTransport.close(1006);
	await actorTransport.flush();
	assert.deepEqual(actorCloses.at(-1), [
		1006,
		"WebSocket disconnected without sending Close frame.",
		false,
	]);
});

test("rejects missing and already-claimed upgrade tokens", () => {
	class ChatRoom extends DurableObject {}
	const generation = createDurableObjectGeneration({
		bindings: {},
		className: "ChatRoom",
		userClass: ChatRoom,
	});
	const closed: Array<[number | undefined, string | undefined]> = [];
	const transport: RivetWebSocket = {
		addEventListener: () => undefined,
		binaryType: "blob",
		close(code?: number, reason?: string): void {
			closed.push([code, reason]);
		},
		readyState: 1,
		removeEventListener: () => undefined,
		send: () => undefined,
	};

	attachDurableObjectWebSocket(
		generation,
		new Request("http://actor/websocket"),
		transport,
	);
	attachDurableObjectWebSocket(
		generation,
		new Request("http://actor/websocket?token=unknown"),
		transport,
	);

	assert.deepEqual(closed, [
		[1008, "Durable Object WebSocket token is missing"],
		[1008, "Durable Object WebSocket upgrade token is invalid or expired"],
	]);
});
