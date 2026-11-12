import assert from "node:assert/strict";
import test from "node:test";

import { DurableObject } from "../../../modules/cloudflare-workers/index.js";
import type { DurableObjectStub } from "../namespace.js";
import { createDurableObjectNamespace } from "../namespace.js";
import {
	createDurableObjectActorDefinitions,
	runningDurableObjectGeneration,
} from "../registry.js";
import {
	disposeDurableObjectGeneration,
	type DurableObjectGeneration,
} from "../state.js";
import {
	createLinkedTestWebSocketPair,
	type LinkedTestWebSocket,
} from "./test-websocket.js";
import { callDurableObjectRpc } from "./session.js";
import { fakeRivetActorHandle, runtimeActorRequest, runtimeActorWebSocket } from "../test-actor-handle.js";

const encoder = new TextEncoder();

async function waitFor(predicate: () => boolean): Promise<void> {
	for (let attempt = 0; attempt < 100; attempt += 1) {
		if (predicate()) return;
		await new Promise<void>((resolve) => setImmediate(resolve));
	}
	throw new Error("Timed out waiting for streaming RPC state");
}

async function within<T>(promise: PromiseLike<T>, label: string): Promise<T> {
	let timeout: ReturnType<typeof setTimeout> | undefined;
	try {
		return await Promise.race([
			Promise.resolve(promise),
			new Promise<never>((_resolve, reject) => {
				timeout = setTimeout(
					() => reject(new Error(`Timed out during ${label}`)),
					2_000,
				);
			}),
		]);
	} finally {
		if (timeout !== undefined) clearTimeout(timeout);
	}
}

function byteLength(value: Uint8Array | undefined): number {
	return value?.byteLength ?? 0;
}

class StreamingObject extends DurableObject {
	readonly inputReadStarted = Promise.withResolvers<void>();
	readonly inputReadContinue = Promise.withResolvers<void>();
	readonly outputCanceled = Promise.withResolvers<unknown>();
	readonly writableAborted = Promise.withResolvers<unknown>();
	readonly writableChunks: Uint8Array[] = [];
	writableClosed = false;

	async readWithBackpressure(
		readable: ReadableStream<Uint8Array>,
	): Promise<number> {
		const reader = readable.getReader();
		let total = 0;
		try {
			const first = await reader.read();
			total += byteLength(first.value);
			this.inputReadStarted.resolve();
			await this.inputReadContinue.promise;
			while (true) {
				const entry = await reader.read();
				if (entry.done) return total;
				total += byteLength(entry.value);
			}
		} finally {
			reader.releaseLock();
		}
	}

	async cancelInput(readable: ReadableStream<Uint8Array>): Promise<number> {
		const reader = readable.getReader();
		try {
			const first = await reader.read();
			await reader.cancel(new Error("actor canceled input"));
			return byteLength(first.value);
		} finally {
			reader.releaseLock();
		}
	}

	createReadable(): ReadableStream<Uint8Array> {
		let sent = false;
		return new ReadableStream<Uint8Array>({
			cancel: (reason) => {
				this.outputCanceled.resolve(reason);
			},
			pull(controller) {
				if (sent) return;
				sent = true;
				controller.enqueue(encoder.encode("first output"));
			},
		});
	}

	async writeTo(writable: WritableStream<Uint8Array>): Promise<number> {
		const writer = writable.getWriter();
		try {
			const chunk = new Uint8Array(64 * 1024);
			await writer.write(chunk);
			await writer.close();
			return chunk.byteLength;
		} finally {
			writer.releaseLock();
		}
	}

	async abortWritable(writable: WritableStream<Uint8Array>): Promise<void> {
		const writer = writable.getWriter();
		try {
			await writer.abort(new Error("actor aborted writable"));
		} finally {
			writer.releaseLock();
		}
	}

	createWritable(): WritableStream<Uint8Array> {
		return new WritableStream<Uint8Array>({
			abort: (reason) => {
				this.writableAborted.resolve(reason);
			},
			close: () => {
				this.writableClosed = true;
			},
			write: (chunk) => {
				this.writableChunks.push(chunk);
			},
		});
	}

	async inspectRequest(request: Request): Promise<{
		body: string;
		header: string | null;
		method: string;
		url: string;
	}> {
		return {
			body: await request.text(),
			header: request.headers.get("x-stream-fixture"),
			method: request.method,
			url: request.url,
		};
	}

	async cancelRequestBody(request: Request): Promise<void> {
		if (request.body === null) throw new Error("request body is missing");
		const reader = request.body.getReader();
		try {
			await reader.read();
			await reader.cancel(new Error("actor canceled request body"));
		} finally {
			reader.releaseLock();
		}
	}

	createResponse(): Response {
		return new Response("response body", {
			headers: { "x-stream-fixture": "response" },
			status: 207,
			statusText: "Fixture",
		});
	}

	createCancelableResponse(): Response {
		return new Response(this.createReadable(), { status: 206 });
	}
}

interface StreamingHarness {
	readonly clientSockets: LinkedTestWebSocket[];
	dispose(): Promise<void>;
	readonly generation: DurableObjectGeneration;
	readonly serverSockets: LinkedTestWebSocket[];
	readonly stub: DurableObjectStub<StreamingObject>;
}

async function createStreamingHarness(): Promise<StreamingHarness> {
	const registrations = createDurableObjectActorDefinitions({
		classes: new Map([["StreamingObject", StreamingObject]]),
		deploymentIdentity: "streaming-fixture:development",
	});
	const registration = registrations.values().next().value;
	assert.ok(registration);
	const generation = runningDurableObjectGeneration(
		await registration.definition.config.createVars(),
	);
	const clientSockets: LinkedTestWebSocket[] = [];
	const serverSockets: LinkedTestWebSocket[] = [];
	const handle = fakeRivetActorHandle({
		async fetch(request: Request): Promise<Response> {
			return runtimeActorRequest(registration.definition.config, generation, request);
		},
		async webSocket(path: string) {
			const [client, server] = createLinkedTestWebSocketPair();
			await runtimeActorWebSocket(registration.definition.config, generation, path, server);
			clientSockets.push(client);
			serverSockets.push(server);
			return client;
		},
	});
	const namespace = createDurableObjectNamespace<StreamingObject>({
		className: "StreamingObject",
		deploymentIdentity: "streaming-fixture:development",
		resolveActor: () => handle,
	});
	return {
		clientSockets,
		async dispose(): Promise<void> {
			for (const socket of clientSockets) await socket.flush();
			for (const socket of serverSockets) await socket.flush();
			for (const socket of clientSockets) {
				if (socket.readyState < 2) socket.close(1000, "fixture cleanup");
			}
			for (const socket of clientSockets) await socket.flush();
			for (const socket of serverSockets) await socket.flush();
			await disposeDurableObjectGeneration(generation);
		},
		generation,
		serverSockets,
		stub: namespace.getByName("streaming"),
	};
}

function requireStreamingInstance(
	generation: DurableObjectGeneration,
): StreamingObject {
	const instance = generation.instance;
	assert.ok(instance instanceof StreamingObject);
	return instance;
}

test("streams readable input with bounded prefetch and keeps its actor session open", async () => {
	const harness = await createStreamingHarness();
	try {
		const chunkCount = 32;
		const chunkBytes = 64 * 1024;
		let pulls = 0;
		const readable = new ReadableStream<Uint8Array>({
			pull(controller) {
				pulls += 1;
				controller.enqueue(new Uint8Array(chunkBytes));
				if (pulls === chunkCount) controller.close();
			},
		});
		const instance = requireStreamingInstance(harness.generation);
		const pending = harness.stub.readWithBackpressure(readable);
		await instance.inputReadStarted.promise;

		assert.ok(pulls < chunkCount, `stream eagerly pulled all ${pulls} chunks`);
		assert.equal(harness.clientSockets.length, 1);
		assert.equal(harness.clientSockets[0]?.readyState, 1);
		instance.inputReadContinue.resolve();
		assert.equal(await pending, chunkCount * chunkBytes);
		await waitFor(() => harness.clientSockets[0]?.readyState === 3);
	} finally {
		await harness.dispose();
	}
});

test("propagates readable input cancellation back to the caller", async () => {
	const inputHarness = await createStreamingHarness();
	try {
		const canceled = Promise.withResolvers<unknown>();
		const input = new ReadableStream<Uint8Array>({
			cancel: canceled.resolve,
			start(controller) {
				controller.enqueue(encoder.encode("input"));
			},
		});
		assert.equal(
			await within(inputHarness.stub.cancelInput(input), "input cancel RPC"),
			5,
		);
		const inputReason = await within(canceled.promise, "input source cancel");
		assert.ok(inputReason instanceof Error);
		assert.match(inputReason.message, /actor canceled input/);
	} finally {
		await inputHarness.dispose();
	}
});


test("propagates readable output cancellation back to the actor", async () => {
	const outputHarness = await createStreamingHarness();
	try {
		const instance = requireStreamingInstance(outputHarness.generation);
		const output = await within(
			outputHarness.stub.createReadable(),
			"output stream RPC",
		);
		const reader = output.getReader();
		const first = await within(reader.read(), "output stream read");
		assert.equal(new TextDecoder().decode(first.value), "first output");
		await within(
			reader.cancel(new Error("client canceled output")),
			"output stream cancel",
		);
		reader.releaseLock();
		const outputReason = await within(
			instance.outputCanceled.promise,
			"actor output source cancel",
		);
		assert.ok(outputReason instanceof Error);
		assert.match(outputReason.message, /client canceled output/);
		output[Symbol.dispose]();
	} finally {
		await outputHarness.dispose();
	}
});

test("applies writable backpressure and transfers returned writable streams", async () => {
	const inputHarness = await createStreamingHarness();
	try {
		const writeStarted = Promise.withResolvers<void>();
		const allowWrite = Promise.withResolvers<void>();
		let closed = false;
		const input = new WritableStream<Uint8Array>({
			close: () => {
				closed = true;
			},
			async write() {
				writeStarted.resolve();
				await allowWrite.promise;
			},
		});
		let settled = false;
		const pending = inputHarness.stub.writeTo(input).finally(() => {
			settled = true;
		});
		await writeStarted.promise;
		assert.equal(settled, false);
		assert.equal(inputHarness.clientSockets[0]?.readyState, 1);
		allowWrite.resolve();
		assert.equal(await pending, 64 * 1024);
		assert.equal(closed, true);
	} finally {
		await inputHarness.dispose();
	}

	const outputHarness = await createStreamingHarness();
	try {
		const instance = requireStreamingInstance(outputHarness.generation);
		const output = await outputHarness.stub.createWritable();
		const writer = output.getWriter();
		await writer.write(encoder.encode("returned writable"));
		await writer.close();
		writer.releaseLock();
		assert.equal(instance.writableClosed, true);
		assert.equal(
			new TextDecoder().decode(instance.writableChunks[0]),
			"returned writable",
		);
		output[Symbol.dispose]();
	} finally {
		await outputHarness.dispose();
	}
});

test("propagates writable aborts in both directions", async () => {
	const inputHarness = await createStreamingHarness();
	try {
		const inputAborted = Promise.withResolvers<unknown>();
		const input = new WritableStream<Uint8Array>({
			abort: inputAborted.resolve,
		});
		await within(
			inputHarness.stub.abortWritable(input),
			"input writable abort RPC",
		);
		const inputReason = await within(
			inputAborted.promise,
			"caller writable abort",
		);
		assert.ok(inputReason instanceof Error);
		assert.match(inputReason.message, /actor aborted writable/);
	} finally {
		await inputHarness.dispose();
	}

	const outputHarness = await createStreamingHarness();
	try {
		const instance = requireStreamingInstance(outputHarness.generation);
		const output = await within(
			outputHarness.stub.createWritable(),
			"output writable RPC",
		);
		await output.abort(new Error("client aborted writable"));
		const outputReason = await within(
			instance.writableAborted.promise,
			"actor writable abort",
		);
		assert.ok(outputReason instanceof Error);
		assert.match(outputReason.message, /client aborted writable/);
		output[Symbol.dispose]();
	} finally {
		await outputHarness.dispose();
	}
});

test("streams Request and Response bodies with their metadata", async () => {
	const harness = await createStreamingHarness();
	try {
		const requestResult = await harness.stub.inspectRequest(
			new Request("https://example.com/stream?q=1", {
				body: "request body",
				headers: { "x-stream-fixture": "request" },
				method: "POST",
			}),
		);
		assert.deepEqual(
			{
				body: requestResult.body,
				header: requestResult.header,
				method: requestResult.method,
				url: requestResult.url,
			},
			{
				body: "request body",
				header: "request",
				method: "POST",
				url: "https://example.com/stream?q=1",
			},
		);
		requestResult[Symbol.dispose]();

		const response = await harness.stub.createResponse();
		assert.equal(response.status, 207);
		assert.equal(response.statusText, "Fixture");
		assert.equal(response.headers.get("x-stream-fixture"), "response");
		assert.equal(await response.text(), "response body");
		response[Symbol.dispose]();
	} finally {
		await harness.dispose();
	}
});

interface StreamingRequestInit extends RequestInit {
	duplex: "half";
}

test("propagates Request and Response body cancellation", async () => {
	const inputHarness = await createStreamingHarness();
	try {
		const canceled = Promise.withResolvers<unknown>();
		const body = new ReadableStream<Uint8Array>({
			cancel: canceled.resolve,
			start(controller) {
				controller.enqueue(encoder.encode("request chunk"));
			},
		});
		const init: StreamingRequestInit = {
			body,
			duplex: "half",
			method: "POST",
		};
		await within(
			inputHarness.stub.cancelRequestBody(
				new Request("https://example.com/cancel", init),
			),
			"request body cancel RPC",
		);
		const reason = await within(canceled.promise, "request source cancel");
		assert.ok(reason instanceof Error);
		assert.match(reason.message, /actor canceled request body/);
	} finally {
		await inputHarness.dispose();
	}

	const outputHarness = await createStreamingHarness();
	try {
		const instance = requireStreamingInstance(outputHarness.generation);
		const response = await within(
			outputHarness.stub.createCancelableResponse(),
			"response stream RPC",
		);
		assert.equal(response.status, 206);
		if (response.body === null) throw new Error("response body is missing");
		const reader = response.body.getReader();
		await within(reader.read(), "response body read");
		await within(
			reader.cancel(new Error("client canceled response body")),
			"response body cancel",
		);
		reader.releaseLock();
		const reason = await within(
			instance.outputCanceled.promise,
			"response source cancel",
		);
		assert.ok(reason instanceof Error);
		assert.match(reason.message, /client canceled response body/);
		response[Symbol.dispose]();
	} finally {
		await outputHarness.dispose();
	}
});

test("releases a readable source when its RPC session cannot open", async () => {
	const canceled = Promise.withResolvers<unknown>();
	const readable = new ReadableStream<Uint8Array>({
		cancel: canceled.resolve,
		start(controller) {
			controller.enqueue(encoder.encode("unclaimed"));
		},
	});
	await assert.rejects(
		callDurableObjectRpc(
			{ readable },
			{
				connector: {
					open(): never {
						throw new Error("fixture session failure");
					},
				},
				endpoint: "http://unused.invalid/rpc",
			},
		),
		/fixture session failure/,
	);
	const reason = await within(canceled.promise, "unclaimed stream cleanup");
	assert.ok(reason instanceof Error);
	assert.match(reason.message, /released before transfer/);
});

// Cap'n Web carries ReadableStream and WritableStream over its stream protocol,
// with an adaptive flow-control window and explicit cancel/abort messages.
// https://github.com/cloudflare/capnweb/blob/770eec594df59bc44b5e45582f20ed91ea9ffb60/src/streams.ts#L1-L257
