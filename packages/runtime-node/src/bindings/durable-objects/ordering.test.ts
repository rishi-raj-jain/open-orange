import assert from "node:assert/strict";
import test from "node:test";

import {
	DurableObjectOrderCoordinator,
	DurableObjectStubLifecycle,
	requireDurableObjectStubOrder,
} from "./ordering.js";
import { createDurableObjectNamespace } from "./namespace.js";
import {
	createDurableObjectActorDefinitions,
	runningDurableObjectGeneration,
} from "./registry.js";
import { DurableObject } from "../../modules/cloudflare-workers/index.js";
import { fakeRivetActorHandle, runtimeActorRequest } from "./test-actor-handle.js";

test("starts out-of-order arrivals in sequence without waiting for completion", async () => {
	const coordinator = new DurableObjectOrderCoordinator();
	const firstFinished = Promise.withResolvers<string>();
	const secondFinished = Promise.withResolvers<string>();
	const starts: string[] = [];
	const second = coordinator.run({ key: "stub", sequence: 1 }, () => {
		starts.push("second");
		return secondFinished.promise;
	});
	await new Promise<void>((resolve) => setImmediate(resolve));
	assert.equal(starts.length, 0);

	const first = coordinator.run({ key: "stub", sequence: 0 }, () => {
		starts.push("first");
		return firstFinished.promise;
	});
	await new Promise<void>((resolve) => setImmediate(resolve));
	assert.deepEqual(starts, ["first", "second"]);

	secondFinished.resolve("second result");
	assert.equal(await second, "second result");
	firstFinished.resolve("first result");
	assert.equal(await first, "first result");
});

test("poisons in-flight and future operations until a new lifecycle is created", async () => {
	const lifecycle = new DurableObjectStubLifecycle();
	const lateResult = Promise.withResolvers<string>();
	const failure = Promise.withResolvers<string>();
	const orders: number[] = [];
	const first = lifecycle.start((order) => {
		orders.push(order.sequence);
		return lateResult.promise;
	});
	const second = lifecycle.start((order) => {
		orders.push(order.sequence);
		return failure.promise;
	});
	const reason = new Error("stub channel failed");
	failure.reject(reason);

	await assert.rejects(first.promise, (error) => error === reason);
	await assert.rejects(second.promise, (error) => error === reason);
	assert.equal(first.abortController.signal.reason, reason);
	assert.equal(second.abortController.signal.reason, reason);
	lateResult.resolve("late result from old generation");

	let futureStarted = false;
	const future = lifecycle.start(async () => {
		futureStarted = true;
		return "unexpected";
	});
	await assert.rejects(future.promise, (error) => error === reason);
	assert.equal(futureStarted, false);
	assert.deepEqual(orders, [0, 1]);

	const replacement = new DurableObjectStubLifecycle();
	const recovered = replacement.start(async (order) => {
		orders.push(order.sequence);
		return "recovered";
	});
	assert.equal(await recovered.promise, "recovered");
	assert.deepEqual(orders, [0, 1, 0]);
});

test("does not replay a rejected logical call and recovers only with a new stub", async () => {
	const reason = new Error("actor transport failed");
	let calls = 0;
	const handle = fakeRivetActorHandle({
		async fetch(): Promise<Response> {
			calls += 1;
			if (calls === 1) throw reason;
			return new Response("recovered");
		},
	});
	const namespace = createDurableObjectNamespace({
		className: "OrderedObject",
		deploymentIdentity: "retry-fixture:development",
		resolveActor: () => handle,
	});
	const broken = namespace.getByName("fixture");
	await assert.rejects(
		broken.fetch("https://worker.example/first"),
		(error) => error === reason,
	);
	await assert.rejects(
		broken.fetch("https://worker.example/future"),
		(error) => error === reason,
	);
	assert.equal(calls, 1);

	const replacement = namespace.getByName("fixture");
	const response = await replacement.fetch("https://worker.example/recovered");
	assert.equal(await response.text(), "recovered");
	assert.equal(calls, 2);
});

class OrderedObject extends DurableObject {
	static readonly starts: string[] = [];

	fetch(request: Request): Response {
		const path = new URL(request.url).pathname;
		OrderedObject.starts.push(path);
		return new Response(path);
	}

	mark(value: string): string {
		OrderedObject.starts.push(value);
		return value;
	}
}

interface PendingFetch {
	reject(reason?: unknown): void;
	readonly request: Request;
	resolve(response: Response): void;
}

test("orders fetch and RPC across reversed private-route arrival", async () => {
	OrderedObject.starts.length = 0;
	const registrations = createDurableObjectActorDefinitions({
		classes: new Map([["OrderedObject", OrderedObject]]),
		deploymentIdentity: "ordering-fixture:development",
	});
	const registration = registrations.values().next().value;
	assert.ok(registration);
	const generation = runningDurableObjectGeneration(
		await registration.definition.config.createVars(),
	);
	const pending: PendingFetch[] = [];
	const handle = fakeRivetActorHandle({
		fetch(request: Request): Promise<Response> {
			return new Promise<Response>((resolve, reject) => {
				pending.push({ reject, request, resolve });
				if (pending.length !== 2) return;
				const first = pending.shift();
				const second = pending.shift();
				if (first === undefined || second === undefined) {
					throw new Error("Ordering fixture lost a pending request");
				}
				void Promise.resolve(
					runtimeActorRequest(registration.definition.config, generation, second.request,
					)).then(second.resolve, second.reject);
				void Promise.resolve(
					runtimeActorRequest(registration.definition.config, generation, first.request,
					)).then(first.resolve, first.reject);
			});
		},
	});
	const namespace = createDurableObjectNamespace<OrderedObject>({
		className: "OrderedObject",
		deploymentIdentity: "ordering-fixture:development",
		resolveActor: () => handle,
	});
	const stub = namespace.getByName("fixture");
	const [first, second] = await Promise.all([
		stub.fetch("https://worker.example/first"),
		stub.mark("/rpc"),
	]);

	assert.deepEqual(OrderedObject.starts, ["/first", "/rpc"]);
	assert.equal(await first.text(), "/first");
	assert.equal(second, "/rpc");
});

test("rejects malformed, duplicate, stale, and excessively future order metadata", async () => {
	assert.throws(
		() => requireDurableObjectStubOrder({ key: "", sequence: 0 }),
		/order key is invalid/,
	);
	assert.throws(
		() => requireDurableObjectStubOrder({ key: "stub", sequence: -1 }),
		/order sequence is invalid/,
	);
	const coordinator = new DurableObjectOrderCoordinator();
	await coordinator.run({ key: "stub", sequence: 0 }, () => undefined);
	await assert.rejects(
		coordinator.run({ key: "stub", sequence: 0 }, () => undefined),
		/duplicated or stale/,
	);
	await assert.rejects(
		coordinator.run({ key: "other", sequence: 1_025 }, () => undefined),
		/too far out of order/,
	);
});
