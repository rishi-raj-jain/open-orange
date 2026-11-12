import assert from "node:assert/strict";
import test from "node:test";

import {
	createDurableObjectIdScope,
	type DurableObjectId,
} from "./id.js";

test("creates deterministic named IDs with canonical string round trips", () => {
	const scope = createDurableObjectIdScope({
		namespaceKey: "deployment:Counter",
	});
	const first = scope.idFromName("alice");
	const second = scope.idFromName("alice");
	const other = scope.idFromName("bob");

	assert.match(first.toString(), /^[a-f0-9]{64}$/);
	assert.equal(first.toString(), second.toString());
	assert.notEqual(first.toString(), other.toString());
	assert.equal(first.name, "alice");
	assert.equal(first.jurisdiction, undefined);
	assert.equal(first.equals(second), true);
	assert.equal(first.equals(other), false);

	const parsed = scope.idFromString(first.toString().toUpperCase());
	assert.equal(parsed.toString(), first.toString());
	assert.equal(parsed.name, undefined);
	assert.equal(parsed.equals(first), true);
});

test("creates disjoint random unique IDs", () => {
	const scope = createDurableObjectIdScope({
		namespaceKey: "deployment:Counter",
	});
	const named = scope.idFromName("");
	const first = scope.newUniqueId();
	const second = scope.newUniqueId();

	assert.match(first.toString(), /^[a-f0-9]{64}$/);
	assert.notEqual(first.toString(), second.toString());
	assert.notEqual(first.toString(), named.toString());
	assert.equal(first.name, undefined);
	assert.equal(scope.idFromString(first.toString()).equals(first), true);
});

test("preserves and restricts jurisdiction metadata", () => {
	const unrestricted = createDurableObjectIdScope({
		namespaceKey: "deployment:Counter",
	});
	const european = createDurableObjectIdScope({
		jurisdiction: "eu",
		namespaceKey: "deployment:Counter",
	});
	const named = european.idFromName("alice");
	const unique = unrestricted.newUniqueId({ jurisdiction: "fedramp-high" });

	assert.equal(named.jurisdiction, "eu");
	assert.equal(european.idFromString(named.toString()).jurisdiction, "eu");
	assert.equal(unique.jurisdiction, "fedramp-high");
	assert.equal(
		unrestricted.idFromString(unique.toString()).jurisdiction,
		"fedramp-high",
	);
	assert.throws(
		() => european.idFromString(unique.toString()),
		/does not match namespace jurisdiction eu/,
	);
	assert.throws(
		() => european.idFromString(unrestricted.newUniqueId().toString()),
		/default does not match namespace jurisdiction eu/,
	);
	assert.throws(
		() => european.newUniqueId({ jurisdiction: "us" }),
		/does not match namespace jurisdiction eu/,
	);
});

test("rejects malformed, forged, and cross-namespace IDs", () => {
	const counter = createDurableObjectIdScope({
		namespaceKey: "deployment:Counter",
	});
	const room = createDurableObjectIdScope({ namespaceKey: "deployment:Room" });
	const counterId = counter.idFromName("alice");
	const roomId = room.idFromName("alice");

	assert.throws(() => counter.idFromString("abc"), /must be 64 hex digits/);
	assert.throws(
		() =>
			counter.idFromString(
				`${counterId.toString().slice(0, 48)}ffffffffffffffff`,
			),
		/does not match this Durable Object class/,
	);
	assert.throws(
		() => counter.idFromString(`7f${counterId.toString().slice(2)}`),
		/does not match this Durable Object class/,
	);
	assert.throws(
		() => counter.idFromString(roomId.toString()),
		/does not match this Durable Object class/,
	);
	assert.throws(() => counter.assertId(roomId), /not for this Durable Object class/);

	const foreign: unknown = {
		equals(): boolean {
			return false;
		},
		toString(): string {
			return counterId.toString();
		},
	};
	assert.equal(Reflect.apply(counterId.equals, counterId, [foreign]), false);
	assert.throws(
		() => Reflect.apply(counter.assertId, counter, [foreign]),
		/Invalid Durable Object ID/,
	);
});

test("exposes the Cloudflare DurableObjectId structural contract", () => {
	const scope = createDurableObjectIdScope({
		namespaceKey: "deployment:Counter",
	});
	const id: DurableObjectId = scope.idFromName("alice");
	assert.equal(typeof id.equals, "function");
	assert.equal(typeof id.toString, "function");
});
