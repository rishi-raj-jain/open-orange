import assert from "node:assert/strict";
import test from "node:test";

import {
	DurableObject,
	RpcStub,
	RpcTarget,
} from "../../../modules/cloudflare-workers/index.js";
import { createDurableObjectNamespace } from "../namespace.js";
import {
	createDurableObjectActorDefinitions,
	runningDurableObjectGeneration,
} from "../registry.js";
import {
	createDurableObjectMethodHandler,
	isDurableObjectReservedRpcMethod,
} from "./methods.js";
import { disposeDurableObjectGeneration } from "../state.js";
import {
	createLinkedTestWebSocketPair,
	type LinkedTestWebSocket,
} from "./test-websocket.js";
import { fakeRivetActorHandle, runtimeActorRequest, runtimeActorWebSocket } from "../test-actor-handle.js";

class GreeterTarget extends RpcTarget {
	disposals = 0;

	ping(value: string): string {
		return `pong:${value}`;
	}

	[Symbol.dispose](): void {
		this.disposals += 1;
	}
}

class Counter extends DurableObject {
	count = 0;
	readonly greeter = new GreeterTarget();

	add(amount: number): { count: number } {
		this.count += amount;
		return { count: this.count };
	}

	async greet(name: string): Promise<string> {
		await Promise.resolve();
		return `hello ${name} at ${this.count}`;
	}

	fail(): never {
		throw new RangeError("deliberate method failure");
	}

	get summary(): { count: number } {
		return { count: this.count };
	}

	target(): GreeterTarget {
		return this.greeter;
	}

	targetGraph(): { first: GreeterTarget; repeated: GreeterTarget[] } {
		return { first: this.greeter, repeated: [this.greeter] };
	}

	async useCallback(callback: (value: string) => string): Promise<string> {
		return await callback("actor");
	}
}

test("routes lazy stub methods through the Rivet actor RPC endpoint", async () => {
	const registrations = createDurableObjectActorDefinitions({
		classes: new Map([["Counter", Counter]]),
		deploymentIdentity: "fixture:development",
	});
	const registration = registrations.values().next().value;
	assert.ok(registration);
	const generation = runningDurableObjectGeneration(
		await registration.definition.config.createVars(),
	);
	let resolutions = 0;
	const handle = fakeRivetActorHandle({
		async fetch(request: Request): Promise<Response> {
			return runtimeActorRequest(registration.definition.config, generation, request);
		},
	});
	const namespace = createDurableObjectNamespace<Counter>({
		className: "Counter",
		deploymentIdentity: "fixture:development",
		resolveActor() {
			resolutions += 1;
			return handle;
		},
	});
	const stub = namespace.getByName("alice");
	const add = stub.add;

	assert.equal(resolutions, 0);
	const first = add(2);
	assert.equal(typeof Reflect.get(first, "then"), "function");
	assert.deepEqual(await first, { count: 2 });
	assert.deepEqual(await stub.add(3), { count: 5 });
	assert.equal(await stub.greet("Ada"), "hello Ada at 5");
	assert.equal(resolutions, 1);
	await assert.rejects(
		async () => await stub.fail(),
		(error: unknown) =>
			error instanceof Error &&
			error.name === "RangeError" &&
			error.message.includes("deliberate method failure"),
	);
	assert.equal(resolutions, 1);

	await disposeDurableObjectGeneration(generation);
});

function envoyAdmissionRejection(code: string): Response {
	return Response.json(
		{ code, group: "envoy", message: "Actor generation does not match" },
		{ headers: { "x-rivet-error": `envoy.${code}` }, status: 503 },
	);
}

test("resends a stub call that envoy rejected before the object admitted it", async () => {
	const registrations = createDurableObjectActorDefinitions({
		classes: new Map([["Counter", Counter]]),
		deploymentIdentity: "fixture:development",
	});
	const registration = registrations.values().next().value;
	assert.ok(registration);
	const generation = runningDurableObjectGeneration(
		await registration.definition.config.createVars(),
	);
	// The first call reaches a generation that stopped after a reset, as when an
	// object restarts while the call is routed.
	const rejections = ["actor_generation_mismatch", "actor_not_found"];
	const handle = fakeRivetActorHandle({
		async fetch(request: Request): Promise<Response> {
			const code = rejections.shift();
			if (code !== undefined) return envoyAdmissionRejection(code);
			return runtimeActorRequest(registration.definition.config, generation, request);
		},
	});
	const namespace = createDurableObjectNamespace<Counter>({
		className: "Counter",
		deploymentIdentity: "fixture:development",
		resolveActor: () => handle,
	});
	const stub = namespace.getByName("alice");

	assert.deepEqual(await stub.add(2), { count: 2 });
	// The object ran the resent call once.
	assert.deepEqual(await stub.add(3), { count: 5 });

	await disposeDurableObjectGeneration(generation);
});

test("does not resend a stub call that the object may have run", async () => {
	let requests = 0;
	const unavailable = fakeRivetActorHandle({
		async fetch(): Promise<Response> {
			requests += 1;
			return new Response("unavailable", { status: 503 });
		},
	});
	const unavailableStub = createDurableObjectNamespace<Counter>({
		className: "Counter",
		deploymentIdentity: "fixture:development",
		resolveActor: () => unavailable,
	}).getByName("alice");

	await assert.rejects(async () => await unavailableStub.add(1), /RPC request failed: 503/);
	assert.equal(requests, 1);

	// A generation that keeps rejecting the call fails it instead of holding the caller.
	const rejecting = fakeRivetActorHandle({
		async fetch(): Promise<Response> {
			return envoyAdmissionRejection("actor_generation_mismatch");
		},
	});
	const rejectingStub = createDurableObjectNamespace<Counter>({
		className: "Counter",
		deploymentIdentity: "fixture:development",
		resolveActor: () => rejecting,
	}).getByName("bob");

	await assert.rejects(
		async () => await rejectingStub.add(1),
		/RPC request failed: 503 .*\(envoy\.actor_generation_mismatch\)/,
	);
});

test("supports RPC properties, callbacks, pipelining, and explicit capability lifetime", async () => {
	const registrations = createDurableObjectActorDefinitions({
		classes: new Map([["Counter", Counter]]),
		deploymentIdentity: "fixture:development",
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
	const namespace = createDurableObjectNamespace<Counter>({
		className: "Counter",
		deploymentIdentity: "fixture:development",
		resolveActor: () => handle,
	});
	const stub = namespace.getByName("alice");
	await stub.add(4);

	const summary = await stub.summary;
	assert.deepEqual(summary, { count: 4 });
	assert.equal(typeof summary[Symbol.dispose], "function");
	summary[Symbol.dispose]();
	assert.equal(
		await stub.useCallback((value) => `callback:${value}`),
		"callback:actor",
	);

	const pendingTarget = stub.target();
	assert.equal(Reflect.get(pendingTarget, "map"), undefined);
	assert.equal(await pendingTarget.ping("pipeline"), "pong:pipeline");
	const target = await pendingTarget;
	assert.equal(Reflect.get(target, "map"), undefined);
	assert.equal(Reflect.get(target, "onRpcBroken"), undefined);
	const duplicate = target.dup();
	target[Symbol.dispose]();
	assert.equal(await duplicate.ping("duplicate"), "pong:duplicate");
	duplicate[Symbol.dispose]();

	const pendingGraph = stub.targetGraph();
	assert.equal(await pendingGraph.first.ping("nested"), "pong:nested");
	const graph = await pendingGraph;
	assert.strictEqual(graph.first, graph.repeated[0]);
	const graphDuplicate = graph.first.dup();
	graph[Symbol.dispose]();
	assert.equal(
		await graphDuplicate.ping("nested duplicate"),
		"pong:nested duplicate",
	);
	graphDuplicate[Symbol.dispose]();
	for (const socket of serverSockets) await socket.flush();
	assert.ok(clientSockets.every((socket) => socket.readyState === 3));

	const instance = generation.instance;
	assert.ok(instance instanceof Counter);
	assert.equal(instance.greeter.disposals, 2);
	await disposeDurableObjectGeneration(generation);
});

test("rejects reserved, inherited Object, missing, and own-property RPC paths", async () => {
	const registrations = createDurableObjectActorDefinitions({
		classes: new Map([["Counter", Counter]]),
		deploymentIdentity: "fixture:development",
	});
	const registration = registrations.values().next().value;
	assert.ok(registration);
	const generation = runningDurableObjectGeneration(
		await registration.definition.config.createVars(),
	);
	const handler = createDurableObjectMethodHandler(generation);

	assert.equal(isDurableObjectReservedRpcMethod("alarm"), true);
	assert.equal(isDurableObjectReservedRpcMethod("toString"), true);
	assert.equal(isDurableObjectReservedRpcMethod("add"), false);
	await assert.rejects(
		handler({
			args: [],
			methodName: "alarm",
			operation: "call",
			order: { key: "reserved", sequence: 0 },
		}),
		/method alarm is reserved/,
	);
	await assert.rejects(
		handler({
			args: [],
			methodName: "toString",
			operation: "call",
			order: { key: "inherited", sequence: 0 },
		}),
		/method toString is reserved/,
	);
	await assert.rejects(
		handler({
			args: [],
			methodName: "missing",
			operation: "call",
			order: { key: "missing", sequence: 0 },
		}),
		/The RPC receiver does not implement the method "missing"\./,
	);
	await assert.rejects(
		handler({
			args: [],
			methodName: "count",
			operation: "call",
			order: { key: "own", sequence: 0 },
		}),
		/The RPC receiver does not implement the method "count"\./,
	);

	await disposeDurableObjectGeneration(generation);
});

test("exports Cloudflare-compatible RpcTarget and RpcStub constructors", async () => {
	const target = new GreeterTarget();
	const stub = new RpcStub(target);
	const callable = new RpcStub((value: string) => `callable:${value}`);

	assert.equal(await stub.ping("local"), "pong:local");
	assert.equal(await callable("local"), "callable:local");
	callable[Symbol.dispose]();
	stub[Symbol.dispose]();
	assert.equal(target.disposals, 1);
});
