import assert from "node:assert/strict";
import test from "node:test";

import { openCapnWebHttpBatchSession } from "./capnweb.js";
import {
	decodeRpcValue,
	encodeRpcValue,
	type RpcValueExternal,
} from "./codec.js";
import { DurableObjectRpcTarget } from "./target.js";

function requireObject(value: unknown): object {
	assert.ok(typeof value === "object" && value !== null);
	return value;
}

class Target extends DurableObjectRpcTarget {
	ping(): string {
		return "pong";
	}
}

test("round trips cyclic graphs, collections, aliases, and typed views", () => {
	const shared = { label: "shared" };
	const graph = {
		buffer: new ArrayBuffer(12),
		map: new Map<unknown, unknown>(),
		set: new Set<unknown>(),
		shared,
		view: new Uint8Array(),
	};
	graph.view = new Uint8Array(graph.buffer, 2, 6);
	Reflect.set(graph, "alias", shared);
	Reflect.set(graph, "viewAlias", graph.view);
	Reflect.set(graph, "self", graph);
	graph.map.set(shared, graph);
	graph.set.add(shared);
	graph.set.add(graph);

	const decoded = requireObject(decodeRpcValue(encodeRpcValue(graph)));
	const decodedShared = requireObject(Reflect.get(decoded, "shared"));
	assert.strictEqual(Reflect.get(decoded, "alias"), decodedShared);
	assert.strictEqual(Reflect.get(decoded, "self"), decoded);

	const decodedMap = Reflect.get(decoded, "map");
	assert.ok(decodedMap instanceof Map);
	assert.strictEqual(decodedMap.get(decodedShared), decoded);
	const decodedSet = Reflect.get(decoded, "set");
	assert.ok(decodedSet instanceof Set);
	assert.ok(decodedSet.has(decodedShared));
	assert.ok(decodedSet.has(decoded));

	const decodedBuffer = Reflect.get(decoded, "buffer");
	const decodedView = Reflect.get(decoded, "view");
	assert.ok(decodedBuffer instanceof ArrayBuffer);
	assert.ok(decodedView instanceof Uint8Array);
	assert.strictEqual(Reflect.get(decoded, "viewAlias"), decodedView);
	assert.strictEqual(decodedView.buffer, decodedBuffer);
	assert.equal(decodedView.byteOffset, 2);
	assert.equal(decodedView.byteLength, 6);
});

test("extracts nested and repeated Cap'n Web externals by identity", () => {
	const callback = (): string => "called";
	const target = new Target();
	const readable = new ReadableStream<Uint8Array>();
	const writable = new WritableStream<Uint8Array>();
	const request = new Request("https://example.com/request");
	const response = new Response("response");
	const headers = new Headers({ "x-test": "present" });
	const graph = {
		nested: new Map<unknown, unknown>([
			["callback", callback],
			["target", target],
		]),
		repeated: [callback, callback],
		values: [readable, writable, request, response, headers],
	};

	const encoded = encodeRpcValue(graph);
	assert.deepEqual(
		encoded.externals.map((external) => external.kind),
		[
			"function",
			"rpc-target",
			"readable-stream",
			"writable-stream",
			"request",
			"response",
			"headers",
		],
	);
	const decoded = requireObject(decodeRpcValue(encoded));
	const nested = Reflect.get(decoded, "nested");
	assert.ok(nested instanceof Map);
	assert.strictEqual(nested.get("callback"), callback);
	assert.strictEqual(nested.get("target"), target);
	const repeated = Reflect.get(decoded, "repeated");
	assert.ok(Array.isArray(repeated));
	assert.strictEqual(repeated[0], callback);
	assert.strictEqual(repeated[1], callback);
	const values = Reflect.get(decoded, "values");
	assert.ok(Array.isArray(values));
	assert.deepEqual(values, [
		readable,
		writable,
		request,
		response,
		headers,
	]);
});

test("classifies Cap'n Web client stubs as externals", () => {
	const stub = openCapnWebHttpBatchSession("http://actor.invalid/rpc");
	try {
		const encoded = encodeRpcValue({ stub });
		assert.equal(encoded.externals.length, 1);
		assert.equal(encoded.externals[0]?.kind, "rpc-stub");
		const decoded = requireObject(decodeRpcValue(encoded));
		assert.strictEqual(Reflect.get(decoded, "stub"), stub);
	} finally {
		stub[Symbol.dispose]();
	}
});

test("rejects unsupported objects and symbols", () => {
	class Unsupported {}

	assert.throws(
		() => encodeRpcValue(new Unsupported()),
		(error: unknown) => error instanceof DOMException && error.name === "DataCloneError",
	);
	assert.throws(
		() => encodeRpcValue(new WeakMap()),
		(error: unknown) => error instanceof DOMException && error.name === "DataCloneError",
	);
	assert.throws(
		() => encodeRpcValue(new AbortController().signal),
		(error: unknown) => error instanceof DOMException && error.name === "DataCloneError",
	);
	assert.throws(
		() => encodeRpcValue(new URL("https://example.com")),
		(error: unknown) => error instanceof DOMException && error.name === "DataCloneError",
	);
	assert.throws(
		() => encodeRpcValue(Promise.resolve("unsupported")),
		(error: unknown) => error instanceof DOMException && error.name === "DataCloneError",
	);
	assert.throws(
		() => encodeRpcValue(Symbol("unsupported")),
		(error: unknown) => error instanceof DOMException && error.name === "DataCloneError",
	);
});

test("rejects corrupt serialized data and mismatched external tables", () => {
	assert.throws(
		() =>
			decodeRpcValue({
				externals: [],
				v8Serialized: new Uint8Array([1, 2, 3]),
			}),
		(error: unknown) => error instanceof DOMException && error.name === "DataCloneError",
	);

	const callback = (): void => undefined;
	const withExternal = encodeRpcValue({ callback });
	assert.throws(
		() =>
			decodeRpcValue({
				externals: [],
				v8Serialized: withExternal.v8Serialized,
			}),
		/RPC value references a missing external/,
	);

	const extra: RpcValueExternal = { kind: "function", value: callback };
	const withoutExternal = encodeRpcValue("ordinary");
	assert.throws(
		() =>
			decodeRpcValue({
				externals: [extra],
				v8Serialized: withoutExternal.v8Serialized,
			}),
		/RPC value did not consume its complete external table/,
	);
});
