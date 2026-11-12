import assert from "node:assert/strict";
import test from "node:test";

import {
	getActiveCapnWebHttpBatchSessionCount,
} from "./capnweb.js";
import {
	callDurableObjectRpcHttp,
	DurableObjectRpcHttpTarget,
	handleDurableObjectRpcHttp,
} from "./http.js";

function requireObject(value: unknown): object {
	assert.ok(typeof value === "object" && value !== null);
	return value;
}

function routeFetchToTarget(
	target: DurableObjectRpcHttpTarget,
	onRequest: () => void,
): typeof fetch {
	return async (input, init): Promise<Response> => {
		onRequest();
		return handleDurableObjectRpcHttp(new Request(input, init), target);
	};
}

test("completes a value-only async exchange in one short-lived HTTP batch", async () => {
	const target = new DurableObjectRpcHttpTarget(async (value) => {
		await Promise.resolve();
		const input = requireObject(value);
		return {
			alias: Reflect.get(input, "shared"),
			input,
		};
	});
	let requestCount = 0;
	const originalFetch = globalThis.fetch;
	globalThis.fetch = routeFetchToTarget(target, () => {
		requestCount += 1;
	});
	const shared = { value: 42 };
	const input = { shared };
	Reflect.set(input, "self", input);
	try {
		const decoded = requireObject(
			await callDurableObjectRpcHttp("http://actor/rpc", input),
		);
		const decodedInput = requireObject(Reflect.get(decoded, "input"));
		assert.strictEqual(Reflect.get(decodedInput, "self"), decodedInput);
		assert.strictEqual(
			Reflect.get(decoded, "alias"),
			Reflect.get(decodedInput, "shared"),
		);
		assert.equal(requestCount, 1);
		assert.equal(getActiveCapnWebHttpBatchSessionCount(), 0);
	} finally {
		globalThis.fetch = originalFetch;
	}
});

test("tears down an HTTP batch after a remote error", async () => {
	const target = new DurableObjectRpcHttpTarget(() => {
		throw new TypeError("fixture failure");
	});
	const originalFetch = globalThis.fetch;
	globalThis.fetch = routeFetchToTarget(target, () => undefined);
	try {
		await assert.rejects(
			callDurableObjectRpcHttp("http://actor/rpc", "input"),
			/fixture failure/,
		);
		assert.equal(getActiveCapnWebHttpBatchSessionCount(), 0);
	} finally {
		globalThis.fetch = originalFetch;
	}
});

test("cancels an HTTP batch through its request signal and tears it down", async () => {
	const originalFetch = globalThis.fetch;
	let requestCount = 0;
	globalThis.fetch = (input, init): Promise<Response> => {
		requestCount += 1;
		const request = new Request(input, init);
		return new Promise((_resolve, reject) => {
			const rejectForAbort = (): void => {
				reject(request.signal.reason);
			};
			if (request.signal.aborted) rejectForAbort();
			else request.signal.addEventListener("abort", rejectForAbort, { once: true });
		});
	};
	const controller = new AbortController();
	try {
		const pending = callDurableObjectRpcHttp(
			"http://actor/rpc",
			"input",
			{ signal: controller.signal },
		);
		await new Promise<void>((resolve) => setImmediate(resolve));
		controller.abort(new Error("fixture cancellation"));
		await assert.rejects(pending, /fixture cancellation/);
		assert.equal(requestCount, 1);
		assert.equal(getActiveCapnWebHttpBatchSessionCount(), 0);
	} finally {
		globalThis.fetch = originalFetch;
	}
});

test("requires a session for live input or output externals", async () => {
	let requestCount = 0;
	const inputTarget = new DurableObjectRpcHttpTarget((value) => value);
	const originalFetch = globalThis.fetch;
	globalThis.fetch = routeFetchToTarget(inputTarget, () => {
		requestCount += 1;
	});
	try {
		await assert.rejects(
			callDurableObjectRpcHttp("http://actor/rpc", () => undefined),
			/input contains live externals and requires a session/,
		);
		assert.equal(requestCount, 0);

		const outputTarget = new DurableObjectRpcHttpTarget(() => () => undefined);
		globalThis.fetch = routeFetchToTarget(outputTarget, () => {
			requestCount += 1;
		});
		await assert.rejects(
			callDurableObjectRpcHttp("http://actor/rpc", "input"),
			/output contains live externals and requires a session/,
		);
		assert.equal(requestCount, 1);
		assert.equal(getActiveCapnWebHttpBatchSessionCount(), 0);
	} finally {
		globalThis.fetch = originalFetch;
	}
});
