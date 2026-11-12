import assert from "node:assert/strict";
import test from "node:test";

import type { ConfiguredDurableObjectClass } from "./classes.js";
import { createDurableObjectNamespace } from "./namespace.js";
import {
	createDurableObjectActorDefinitions,
	runningDurableObjectGeneration,
} from "./registry.js";
import type { DurableObjectGeneration } from "./state.js";
import { DurableObject } from "../../modules/cloudflare-workers/index.js";
import { fakeRivetActorHandle, runtimeActorRequest } from "./test-actor-handle.js";

const encoder = new TextEncoder();

type FetchStub = ReturnType<
	ReturnType<typeof createDurableObjectNamespace>["getByName"]
>;

interface FetchHarness {
	readonly generation: DurableObjectGeneration;
	replacement(): FetchStub;
	readonly resolutions: () => number;
	readonly stub: FetchStub;
}

async function createFetchHarness(
	className: string,
	userClass: ConfiguredDurableObjectClass,
): Promise<FetchHarness> {
	const registrations = createDurableObjectActorDefinitions({
		classes: new Map([[className, userClass]]),
		deploymentIdentity: "fetch-fixture:development",
	});
	const registration = registrations.values().next().value;
	assert.ok(registration);
	const generation = runningDurableObjectGeneration(
		await registration.definition.config.createVars(),
	);
	const handle = fakeRivetActorHandle({
		async fetch(request: Request): Promise<Response> {
			return runtimeActorRequest(registration.definition.config, generation, request);
		},
	});
	let resolutions = 0;
	const namespace = createDurableObjectNamespace({
		className,
		deploymentIdentity: "fetch-fixture:development",
		resolveActor: () => {
			resolutions += 1;
			return handle;
		},
	});
	return {
		generation,
		replacement: () => namespace.getByName("fixture"),
		resolutions: () => resolutions,
		stub: namespace.getByName("fixture"),
	};
}

class FetchObject extends DurableObject {
	readonly abortStarted = Promise.withResolvers<void>();
	readonly responseCanceled = Promise.withResolvers<unknown>();

	async fetch(request: Request): Promise<Response> {
		const url = new URL(request.url);
		if (url.pathname === "/throws") {
			throw new RangeError("user fetch failed");
		}
		if (url.pathname === "/abort") {
			this.abortStarted.resolve();
			return await new Promise<Response>((_resolve, reject) => {
				const rejectWithReason = (): void => reject(request.signal.reason);
				if (request.signal.aborted) {
					rejectWithReason();
				} else {
					request.signal.addEventListener("abort", rejectWithReason, {
						once: true,
					});
				}
			});
		}
		if (url.pathname === "/stream") {
			let sent = false;
			return new Response(
				new ReadableStream<Uint8Array>({
					cancel: (reason) => this.responseCanceled.resolve(reason),
					pull(controller) {
						if (sent) return;
						sent = true;
						controller.enqueue(encoder.encode("first chunk"));
					},
				}),
				{
					headers: { "x-response": "streaming" },
					status: 206,
					statusText: "Partial Fixture",
				},
			);
		}
		return new Response(
			JSON.stringify({
				body: await request.text(),
				header: request.headers.get("x-request"),
				method: request.method,
				url: request.url,
			}),
			{
				headers: { "content-type": "application/json" },
				status: 207,
				statusText: "Fetch Fixture",
			},
		);
	}
}

test("routes stub.fetch with the original URL, method, headers, and streaming body", async () => {
	const harness = await createFetchHarness("FetchObject", FetchObject);
	const body = new ReadableStream<Uint8Array>({
		start(controller) {
			controller.enqueue(encoder.encode("streamed "));
			controller.enqueue(encoder.encode("request"));
			controller.close();
		},
	});

	assert.equal(harness.resolutions(), 0);
	const response = await harness.stub.fetch(
		"https://worker.example/path/to/object?hello=orange",
		{
			body,
			headers: { "x-request": "preserved" },
			method: "PATCH",
		},
	);
	assert.equal(harness.resolutions(), 1);
	assert.equal(response.status, 207);
	assert.equal(response.statusText, "Fetch Fixture");
	assert.equal(response.headers.get("content-type"), "application/json");
	assert.deepEqual(await response.json(), {
		body: "streamed request",
		header: "preserved",
		method: "PATCH",
		url: "https://worker.example/path/to/object?hello=orange",
	});

	await harness.stub.fetch("https://worker.example/again");
	assert.equal(harness.resolutions(), 1);
});

test("returns response streams without buffering and propagates cancellation", async () => {
	const harness = await createFetchHarness("FetchObject", FetchObject);
	const instance = harness.generation.instance;
	assert.ok(instance instanceof FetchObject);
	const response = await harness.stub.fetch("https://worker.example/stream");

	assert.equal(response.status, 206);
	assert.equal(response.statusText, "Partial Fixture");
	assert.equal(response.headers.get("x-response"), "streaming");
	assert.ok(response.body);
	const reader = response.body.getReader();
	const first = await reader.read();
	assert.equal(new TextDecoder().decode(first.value), "first chunk");
	const reason = new Error("caller canceled response");
	await reader.cancel(reason);
	assert.equal(await instance.responseCanceled.promise, reason);
});

test("propagates request cancellation and user exceptions", async () => {
	const harness = await createFetchHarness("FetchObject", FetchObject);
	const instance = harness.generation.instance;
	assert.ok(instance instanceof FetchObject);
	const controller = new AbortController();
	const pending = harness.stub.fetch("https://worker.example/abort", {
		signal: controller.signal,
	});
	await instance.abortStarted.promise;
	const reason = new Error("caller aborted request");
	controller.abort(reason);
	await assert.rejects(pending, (error) => error === reason);
	await assert.rejects(
		harness.stub.fetch("https://worker.example/throws"),
		(error) => error === reason,
	);

	const replacement = harness.replacement();
	await assert.rejects(
		replacement.fetch("https://worker.example/throws"),
		/user fetch failed/,
	);
	const recovered = await harness
		.replacement()
		.fetch("https://worker.example/recovered");
	assert.equal(recovered.status, 207);
});

test("rejects missing and invalid Durable Object fetch handlers", async () => {
	class MissingFetchObject extends DurableObject {}
	const missing = await createFetchHarness("MissingFetchObject", MissingFetchObject);
	await assert.rejects(
		missing.stub.fetch("https://worker.example/"),
		/Handler does not export a fetch\(\) function\./,
	);

	class InvalidFetchObject extends DurableObject {}
	Object.defineProperty(InvalidFetchObject.prototype, "fetch", {
		value: () => "not a response",
	});
	const invalid = await createFetchHarness("InvalidFetchObject", InvalidFetchObject);
	await assert.rejects(
		invalid.stub.fetch("https://worker.example/"),
		/did not resolve to .Response./,
	);
});
