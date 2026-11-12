import assert from "node:assert/strict";
import test from "node:test";

import {
	createDurableObjectNamespace,
	requireDurableObjectStubDescriptor,
	resolveDurableObjectStub,
} from "./namespace.js";
import { fakeRivetActorHandle } from "./test-actor-handle.js";

test("implements named, unique, and string namespace ID operations", () => {
	const namespace = createDurableObjectNamespace({
		className: "Counter",
		deploymentIdentity: "project:development",
	});
	const named = namespace.idFromName("alice");
	const unique = namespace.newUniqueId();

	assert.equal(namespace.idFromName("alice").equals(named), true);
	assert.equal(namespace.idFromString(named.toString()).equals(named), true);
	assert.equal(unique.equals(named), false);
	assert.equal(namespace.idFromString(unique.toString()).equals(unique), true);
});

test("creates lazy stubs with placement metadata without resolving an actor", () => {
	const handle = fakeRivetActorHandle({});
	let resolutions = 0;
	const namespace = createDurableObjectNamespace({
		className: "Counter",
		deploymentIdentity: "project:development",
		resolveActor() {
			resolutions += 1;
			return handle;
		},
	});
	const id = namespace.idFromName("alice");
	const stub = namespace.get(id, {
		locationHint: "weur",
		routingMode: "primary-only",
	});

	assert.equal(stub.id, id);
	assert.equal(stub.name, "alice");
	assert.deepEqual(requireDurableObjectStubDescriptor(stub), {
		className: "Counter",
		deploymentIdentity: "project:development",
		id,
		locationHint: "weur",
		routingMode: "primary-only",
	});
	assert.deepEqual(Object.keys(stub), ["id", "name"]);
	assert.equal(resolutions, 0);
	assert.equal(resolveDurableObjectStub(stub), handle);
	assert.equal(resolveDurableObjectStub(stub), handle);
	assert.equal(resolutions, 1);
});

test("implements getByName and jurisdiction subnamespaces", () => {
	const namespace = createDurableObjectNamespace({
		className: "Counter",
		deploymentIdentity: "project:development",
	});
	const european = namespace.jurisdiction("eu");
	const stub = european.getByName("alice", { locationHint: "eeur" });

	assert.equal(stub.name, "alice");
	assert.equal(stub.id.jurisdiction, "eu");
	assert.deepEqual(requireDurableObjectStubDescriptor(stub), {
		className: "Counter",
		deploymentIdentity: "project:development",
		id: stub.id,
		jurisdiction: "eu",
		locationHint: "eeur",
	});
});

test("shares class namespaces and rejects incompatible IDs and options", () => {
	const counter = createDurableObjectNamespace({
		className: "Counter",
		deploymentIdentity: "project:development",
	});
	const counterAlias = createDurableObjectNamespace({
		className: "Counter",
		deploymentIdentity: "project:development",
	});
	const room = createDurableObjectNamespace({
		className: "Room",
		deploymentIdentity: "project:development",
	});
	const counterId = counter.idFromName("alice");

	assert.equal(counterAlias.idFromName("alice").equals(counterId), true);
	assert.throws(() => room.get(counterId), /not for this Durable Object class/);
	assert.throws(
		() => Reflect.apply(counter.get, counter, [counterId, { locationHint: "moon" }]),
		/Unsupported Durable Object location hint: moon/,
	);
	assert.throws(
		() => Reflect.apply(counter.get, counter, [counterId, { routingMode: "random" }]),
		/Unsupported Durable Object routing mode: random/,
	);
	assert.throws(
		() => Reflect.apply(counter.jurisdiction, counter, ["moon"]),
		/Unsupported Durable Object jurisdiction: moon/,
	);
});
