import assert from "node:assert/strict";
import test from "node:test";

import { globalImplementations } from "./globals/implementations.js";
import { Request, Response } from "./globals/http.js";
import { globalManifest } from "./globals/manifest.js";
import { loadWorkerEntrypoint } from "./runtime.js";
import type { FetchHandler } from "./events/fetch.js";
import { DurableObject } from "./modules/cloudflare-workers/durable-object.js";

function snapshotGlobals(): Map<string, PropertyDescriptor | undefined> {
	return new Map(
		globalManifest.map((entry) => [
			entry.name,
			Object.getOwnPropertyDescriptor(globalThis, entry.name),
		]),
	);
}

function restoreGlobals(
	descriptors: ReadonlyMap<string, PropertyDescriptor | undefined>,
): void {
	for (const [name, descriptor] of descriptors) {
		if (descriptor === undefined) {
			Reflect.deleteProperty(globalThis, name);
		} else {
			Object.defineProperty(globalThis, name, descriptor);
		}
	}
}

test("loads and dispatches a module Worker through the controlled runtime", async () => {
	const descriptors = snapshotGlobals();
	let backgroundCompleted = false;
	const NamedExport = class NamedExport {};
	class ConfiguredObject extends DurableObject {}
	class UnconfiguredObject extends DurableObject {}
	const handler: FetchHandler<{ requestId: string }> = (
		request,
		environment,
		context,
	) => {
		assert.equal(Reflect.get(context.exports, "NamedExport"), NamedExport);
		assert.deepEqual(context.props, { requestId: "request-1" });
		context.waitUntil(
			Promise.resolve().then(() => {
				backgroundCompleted = true;
			}),
		);
		return Response.json({
			message: environment.MESSAGE,
			method: request.method,
		});
	};
	try {
		const worker = await loadWorkerEntrypoint({
			bindings: [{ name: "MESSAGE", value: "hello" }],
			durableObjectManifest: {
				classes: [{ className: "ConfiguredObject" }],
			},
			async importWorker(): Promise<unknown> {
				assert.equal(globalThis.atob, globalImplementations.atob);
				assert.equal(globalThis.Response, Response);
				return {
					ConfiguredObject,
					NamedExport,
					UnconfiguredObject,
					default: { fetch: handler },
				};
			},
		});

		assert.equal(worker.exports.NamedExport, NamedExport);
		assert.equal(
			worker.durableObjectClasses.get("ConfiguredObject"),
			ConfiguredObject,
		);
		assert.equal(worker.durableObjectClasses.has("UnconfiguredObject"), false);
		assert.equal(worker.environment.MESSAGE, "hello");
		const dispatch = await worker.dispatch(
			new Request("https://example.com/", { method: "POST", body: "body" }),
			{ requestId: "request-1" },
		);
		assert.deepEqual(await dispatch.response.json(), {
			message: "hello",
			method: "POST",
		});
		assert.deepEqual(
			(await dispatch.waitUntil).map((outcome) => outcome.status),
			["fulfilled"],
		);
		assert.equal(backgroundCompleted, true);
	} finally {
		restoreGlobals(descriptors);
	}
});

test("serves fetch for a Worker that also exports other event handlers", async () => {
	const worker = await loadWorkerEntrypoint({
		globalTarget: {},
		async importWorker(): Promise<unknown> {
			return {
				default: {
					fetch: () => new Response("ok"),
					queue: () => undefined,
					scheduled: () => undefined,
				},
			};
		},
	});
	const dispatch = await worker.dispatch(new Request("https://example.com/"), undefined);
	assert.equal(await dispatch.response.text(), "ok");
});

test("fails each request when the Worker has no fetch handler", async () => {
	const worker = await loadWorkerEntrypoint({
		globalTarget: {},
		async importWorker(): Promise<unknown> {
			return { default: { scheduled: () => undefined } };
		},
	});
	await assert.rejects(
		worker.dispatch(new Request("https://example.com/"), undefined),
		/Handler does not export a fetch\(\) function/,
	);
});

test("rejects invalid fetch results", async () => {
	const worker = await loadWorkerEntrypoint({
		globalTarget: {},
		async importWorker(): Promise<unknown> {
			return { default: { fetch: () => "not a response" } };
		},
	});
	await assert.rejects(
		worker.dispatch(new Request("https://example.com/"), undefined),
		/Worker fetch handler must return a Response/,
	);
});
