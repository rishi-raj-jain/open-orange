import assert from "node:assert/strict";
import { setImmediate } from "node:timers/promises";
import test from "node:test";

import { Blob } from "./native.js";
import {
	WebSocket,
	WebSocketPair,
	WebSocketRequestResponsePair,
} from "./websocket.js";

function eventData(event: unknown): unknown {
	return typeof event === "object" && event !== null
		? Reflect.get(event, "data")
		: undefined;
}

function isArrayBuffer(value: unknown): value is ArrayBuffer {
	return (
		typeof value === "object" &&
		value !== null &&
		Object.prototype.toString.call(value) === "[object ArrayBuffer]"
	);
}

function isBlob(value: unknown): value is Blob {
	return (
		typeof value === "object" &&
		value !== null &&
		typeof Reflect.get(value, "arrayBuffer") === "function" &&
		Object.prototype.toString.call(value) === "[object Blob]"
	);
}

function closeObservation(event: unknown): object {
	if (typeof event !== "object" || event === null) return {};
	return {
		code: Reflect.get(event, "code"),
		reason: Reflect.get(event, "reason"),
		wasClean: Reflect.get(event, "wasClean"),
	};
}

test("constructs an enumerable entangled WebSocketPair", () => {
	const pair = new WebSocketPair();
	assert.deepEqual(Object.keys(pair), ["0", "1"]);
	assert.ok(pair[0] instanceof WebSocket);
	assert.ok(pair[1] instanceof WebSocket);
	assert.notEqual(pair[0], pair[1]);
	assert.equal(pair[0].readyState, WebSocket.OPEN);
	assert.equal(pair[1].readyState, WebSocket.READY_STATE_OPEN);
	assert.equal(pair[0].url, null);
	assert.equal(pair[0].protocol, null);
	assert.equal(pair[0].extensions, null);
});

test("constructs immutable WebSocket request-response pairs", () => {
	const pair = new WebSocketRequestResponsePair("ping", "pong");
	assert.equal(pair.request, "ping");
	assert.equal(pair.response, "pong");
	assert.deepEqual(Object.keys(pair), []);
	assert.equal(
		Object.getOwnPropertyDescriptor(
			WebSocketRequestResponsePair.prototype,
			"request",
		)?.set,
		undefined,
	);
});

test("queues text and copied binary frames until the peer accepts", async () => {
	const pair = new WebSocketPair();
	const received: unknown[] = [];
	pair[1].binaryType = "arraybuffer";
	pair[1].addEventListener("message", (event: unknown) => {
		received.push(eventData(event));
	});
	pair[0].accept();
	pair[0].send("hello");
	const bytes = new Uint8Array([1, 2, 3]);
	pair[0].send(bytes);
	bytes.fill(9);
	await setImmediate();
	assert.deepEqual(received, []);

	pair[1].accept();
	assert.equal(received[0], "hello");
	const binary = received[1];
	assert.ok(isArrayBuffer(binary));
	assert.deepEqual([...new Uint8Array(binary)], [1, 2, 3]);

	const blobMessages: unknown[] = [];
	pair[0].addEventListener("message", (event: unknown) => {
		blobMessages.push(eventData(event));
	});
	pair[1].send(new Uint8Array([4, 5]));
	await setImmediate();
	const blob = blobMessages[0];
	assert.ok(isBlob(blob));
	assert.deepEqual([...new Uint8Array(await blob.arrayBuffer())], [4, 5]);
});

test("requires acceptance and validates close arguments before state", () => {
	const socket = new WebSocketPair()[0];
	assert.throws(
		() => socket.send("early"),
		/You must call one of accept\(\) or state\.acceptWebSocket\(\)/,
	);
	assert.throws(
		() => socket.close(1005),
		(error: unknown) =>
			error instanceof Error &&
			error.name === "InvalidAccessError" &&
			error.message === "Invalid WebSocket close code: 1005.",
	);
	assert.throws(
		() => socket.close(undefined, "reason"),
		(error: unknown) =>
			error instanceof Error &&
			error.name === "InvalidAccessError",
	);
	assert.throws(
		() => socket.close(1000, "😀".repeat(31)),
		(error: unknown) => error instanceof Error && error.name === "SyntaxError",
	);
});

test("auto-replies to close unless the receiver allows half-open state", async () => {
	const pair = new WebSocketPair();
	const firstCloses: object[] = [];
	const secondCloses: object[] = [];
	pair[0].accept();
	pair[1].accept();
	pair[0].addEventListener("close", (event: unknown) => {
		firstCloses.push(closeObservation(event));
	});
	pair[1].addEventListener("close", (event: unknown) => {
		secondCloses.push(closeObservation(event));
	});
	pair[0].close(3001, "done");
	await setImmediate();
	assert.equal(pair[0].readyState, WebSocket.CLOSED);
	assert.equal(pair[1].readyState, WebSocket.READY_STATE_CLOSED);
	assert.deepEqual(firstCloses, [{ code: 3001, reason: "done", wasClean: true }]);
	assert.deepEqual(secondCloses, [{ code: 3001, reason: "done", wasClean: true }]);
	pair[0].close(1000);

	const halfOpen = new WebSocketPair();
	halfOpen[0].accept();
	halfOpen[1].accept({ allowHalfOpen: true });
	halfOpen[0].close(3002, "half");
	await setImmediate();
	assert.equal(halfOpen[0].readyState, WebSocket.CLOSING);
	assert.equal(halfOpen[1].readyState, WebSocket.CLOSING);
	halfOpen[1].close(3002, "half");
	await setImmediate();
	assert.equal(halfOpen[0].readyState, WebSocket.CLOSED);
	assert.equal(halfOpen[1].readyState, WebSocket.CLOSED);
});
