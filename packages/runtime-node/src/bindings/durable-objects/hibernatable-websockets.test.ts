import assert from "node:assert/strict";
import test from "node:test";

import {
	WebSocket,
	WebSocketPair,
	WebSocketRequestResponsePair,
} from "../../globals/websocket.js";
import type { RivetActorConnection } from "../../internal/rivetkit.js";
import { DurableObjectHibernatableWebSocketStore } from "./hibernatable-websockets.js";
import { isRecord } from "../unknown-values.js";

function nextEvent(socket: WebSocket, type: string): Promise<unknown> {
	return new Promise((resolve) => socket.addEventListener(type, resolve, { once: true }));
}

class TestConnection implements RivetActorConnection {
	readonly isHibernatable = true;
	state: unknown = null;

	constructor(readonly id: string) {}
}

test("registers hibernatable sockets with distinct filterable tags", async () => {
	const store = new DurableObjectHibernatableWebSocketStore();
	const first = new WebSocketPair();
	const second = new WebSocketPair();

	store.acceptWebSocket(first[1], ["room", "alice", "room"]);
	store.acceptWebSocket(second[1], ["room", "bob"]);
	assert.deepEqual(store.getWebSockets(), [first[1], second[1]]);
	assert.deepEqual(store.getWebSockets("alice"), [first[1]]);
	assert.deepEqual(store.getWebSockets("missing"), []);
	assert.deepEqual(store.getTags(first[1]), ["room", "alice"]);

	const tags = store.getTags(first[1]);
	tags.push("mutated");
	assert.deepEqual(store.getTags(first[1]), ["room", "alice"]);
	assert.throws(
		() => first[1].accept(),
		/Can't accept\(\) WebSocket after enabling hibernation/,
	);

	first[0].accept();
	const closed = nextEvent(first[1], "close");
	first[0].close(1000, "done");
	await closed;
	assert.deepEqual(store.getWebSockets(), [second[1]]);
});

test("validates hibernatable acceptance and tag limits", () => {
	const store = new DurableObjectHibernatableWebSocketStore();
	const accepted = new WebSocketPair();
	accepted[1].accept();
	assert.throws(
		() => store.acceptWebSocket(accepted[1]),
		/already accepted via `accept\(\)`/,
	);

	const peerAccepted = new WebSocketPair();
	peerAccepted[0].accept();
	assert.throws(
		() => store.acceptWebSocket(peerAccepted[1]),
		/pair has already been accepted or used in a Response/,
	);

	const unknown = new WebSocketPair();
	assert.throws(
		() => store.getTags(unknown[1]),
		/you must call 'acceptWebSocket\(\)' before attempting to access the tags/,
	);
});

test("configures and clears the hibernatable event timeout", () => {
	const store = new DurableObjectHibernatableWebSocketStore();
	assert.equal(store.getEventTimeout(), null);
	store.setEventTimeout(12_345);
	assert.equal(store.getEventTimeout(), 12_345);
	store.setEventTimeout(0);
	assert.equal(store.getEventTimeout(), null);
	// Cloudflare stops at 7 days. Orange stops at the longest Node.js timer.
	store.setEventTimeout(604_800_001);
	assert.equal(store.getEventTimeout(), 604_800_001);
	assert.throws(
		() => store.setEventTimeout(2_147_483_648),
		/Event timeout should not exceed 2147483647 ms, the longest delay of a Node\.js timer/,
	);
	store.setEventTimeout();
	assert.equal(store.getEventTimeout(), null);
});

test("configures automatic responses and persists their timestamps", async () => {
	const store = new DurableObjectHibernatableWebSocketStore();
	assert.equal(store.getAutoResponse(), null);
	const configured = new WebSocketRequestResponsePair("ping", "pong");
	store.setAutoResponse(configured);
	const firstRead = store.getAutoResponse();
	const secondRead = store.getAutoResponse();
	assert.equal(firstRead?.request, configured.request);
	assert.equal(firstRead?.response, configured.response);
	assert.notEqual(firstRead, configured);
	assert.notEqual(firstRead, secondRead);

	const pair = new WebSocketPair();
	store.acceptWebSocket(pair[1], ["room"]);
	const connection = new TestConnection("auto-response");
	assert.equal(store.bindConnection(pair[0], connection), true);
	store.recordAutoResponse(pair[1], 1_700_000_000_000);
	const timestamp = store.getAutoResponseTimestamp(pair[1]);
	assert.equal(timestamp?.getTime(), 1_700_000_000_000);
	assert.ok(isRecord(connection.state));
	assert.equal(connection.state.autoResponseTimestamp, timestamp.getTime());

	store.releaseForSleep();
	const restoredStore = new DurableObjectHibernatableWebSocketStore();
	const restored = restoredStore.restoreConnection(connection);
	assert.ok(restored);
	assert.equal(
		restoredStore.getAutoResponseTimestamp(restored.userSocket)?.getTime(),
		timestamp.getTime(),
	);

	store.setAutoResponse();
	assert.equal(store.getAutoResponse(), null);
	assert.equal(store.getAutoResponseTimestamp(pair[1])?.getTime(), timestamp.getTime());
});

test("persists and restores attachment graphs and tags through connection state", async () => {
	const firstStore = new DurableObjectHibernatableWebSocketStore();
	const pair = new WebSocketPair();
	const shared = { count: 7 };
	const attachment: Record<string, unknown> = {
		bytes: new Uint8Array([1, 2, 3]),
		left: shared,
		right: shared,
	};
	attachment.self = attachment;
	pair[1].serializeAttachment(attachment);
	firstStore.acceptWebSocket(pair[1], ["room", "alice"]);
	const connection = new TestConnection("connection-1");
	assert.equal(firstStore.bindConnection(pair[0], connection), true);
	assert.ok(isRecord(connection.state));
	assert.equal(connection.state.kind, "open-orange:durable-object-websocket");
	assert.deepEqual(connection.state.tags, ["room", "alice"]);
	assert.equal(typeof connection.state.attachment, "string");

	firstStore.releaseForSleep();
	assert.deepEqual(firstStore.getWebSockets(), []);

	const secondStore = new DurableObjectHibernatableWebSocketStore();
	const restored = secondStore.restoreConnection(connection);
	assert.ok(restored);
	assert.deepEqual(secondStore.getWebSockets("room"), [restored.userSocket]);
	assert.deepEqual(secondStore.getTags(restored.userSocket), ["room", "alice"]);
	const decoded = restored.userSocket.deserializeAttachment();
	assert.ok(isRecord(decoded));
	assert.equal(decoded.self, decoded);
	assert.equal(decoded.left, decoded.right);
	assert.deepEqual(decoded.bytes, new Uint8Array([1, 2, 3]));
	const secondDecode = restored.userSocket.deserializeAttachment();
	assert.notEqual(secondDecode, decoded);

	restored.userSocket.serializeAttachment({ updated: true });
	assert.ok(isRecord(connection.state));
	assert.equal(typeof connection.state.attachment, "string");
	assert.deepEqual(restored.userSocket.deserializeAttachment(), { updated: true });

	restored.responseSocket.accept();
	const closed = nextEvent(restored.userSocket, "close");
	restored.responseSocket.close(1000, "done");
	await closed;
	assert.equal(connection.state, null);
	assert.deepEqual(secondStore.getWebSockets(), []);
	assert.deepEqual(secondStore.getWebSockets("room"), []);
});

test("validates attachment cloneability and persisted envelopes", () => {
	const pair = new WebSocketPair();
	assert.equal(pair[1].deserializeAttachment(), null);
	assert.throws(
		() => pair[1].serializeAttachment(() => undefined),
		(error: unknown) => error instanceof Error && error.name === "DataCloneError",
	);
	assert.equal(pair[1].deserializeAttachment(), null);

	const invalid = new DurableObjectHibernatableWebSocketStore();
	assert.throws(
		() =>
			invalid.restoreConnection({
				id: "invalid",
				isHibernatable: true,
				state: {
					attachment: "not base64",
					kind: "open-orange:durable-object-websocket",
					tags: [],
					version: 1,
				},
			}),
		/Persisted Durable Object WebSocket attachment is invalid/,
	);
	assert.equal(
		invalid.restoreConnection({ id: "ordinary", isHibernatable: false, state: null }),
		undefined,
	);
});
