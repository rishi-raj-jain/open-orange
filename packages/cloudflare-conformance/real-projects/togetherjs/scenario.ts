import assert from "node:assert/strict";

import type { Scenario } from "../../src/real-projects/scenario.js";

const initOf = (text: string): { type: string; peerCount: number } => JSON.parse(text);

const scenario: Scenario = async (t) => {
	await t.step("the hub answers its health check", "http", async () => {
		assert.equal(await t.text("/status"), "OK");
	});

	await t.step("peers in a room relay messages, and server-echo returns to the sender", "websocket", async () => {
		const alice = await t.webSocket("/hub/lobby");
		assert.deepEqual(initOf(await alice.next()), { type: "init-connection", peerCount: 0 });
		const bob = await t.webSocket("/hub/lobby");
		assert.deepEqual(initOf(await bob.next()), { type: "init-connection", peerCount: 1 });
		const other = await t.webSocket("/hub/other-room");
		assert.deepEqual(initOf(await other.next()), { type: "init-connection", peerCount: 0 });

		alice.send(JSON.stringify({ type: "hello", clientId: "alice" }));
		assert.deepEqual(JSON.parse(await bob.next()), { type: "hello", clientId: "alice" });

		bob.send(JSON.stringify({ type: "cursor", "server-echo": true }));
		assert.equal(JSON.parse(await alice.next()).type, "cursor");
		assert.equal(JSON.parse(await bob.next()).type, "cursor");

		// The hub drops text that is not JSON, and a room never sees another room's traffic.
		alice.send("not json");
		other.send(JSON.stringify({ type: "elsewhere" }));
		alice.send(JSON.stringify({ type: "after" }));
		assert.equal(JSON.parse(await bob.next()).type, "after");

		await alice.close();
		await bob.close();
		await other.close();
	});

	await t.step("findroom fills the same room until max, then mints another", "do-state", async () => {
		const { name } = await t.json<{ name: string }>("/findroom?prefix=fill&max=2");
		assert.match(name, /^fill__[A-Za-z0-9]{10}$/);
		const first = await t.webSocket(`/hub/${name}`);
		await first.next();
		assert.equal((await t.json<{ name: string }>("/findroom?prefix=fill&max=2")).name, name);
		const second = await t.webSocket(`/hub/${name}`);
		await second.next();
		const next = await t.json<{ name: string }>("/findroom?prefix=fill&max=2");
		assert.notEqual(next.name, name);
		assert.match(next.name, /^fill__/);
		await first.close();
		await second.close();
	});

	await t.step("the registry forgets a room when its last peer leaves", "do-state", async () => {
		const { name } = await t.json<{ name: string }>("/findroom?prefix=leave&max=5");
		const peer = await t.webSocket(`/hub/${name}`);
		await peer.next();
		assert.equal((await t.json<{ name: string }>("/findroom?prefix=leave&max=5")).name, name);
		await peer.close();
		await t.delay(1_000);
		assert.notEqual((await t.json<{ name: string }>("/findroom?prefix=leave&max=5")).name, name);
	});

	await t.step("two sockets stay open while a room hibernates, and a message wakes it", "sleep", async () => {
		const alice = await t.webSocket("/hub/hibernate");
		await alice.next();
		const bob = await t.webSocket("/hub/hibernate");
		await bob.next();
		await t.waitForSleep(60_000);
		alice.send(JSON.stringify({ type: "after-sleep" }));
		assert.equal(JSON.parse(await bob.next()).type, "after-sleep");
		await alice.close();
		await bob.close();
	});

	await t.step("the registry still knows a room after every object sleeps", "sleep", async () => {
		const { name } = await t.json<{ name: string }>("/findroom?prefix=durable&max=5");
		const peer = await t.webSocket(`/hub/${name}`);
		await peer.next();
		await t.waitForSleep(60_000);
		assert.equal((await t.json<{ name: string }>("/findroom?prefix=durable&max=5")).name, name);
		await peer.close();
	});

	await t.step("after a restart a room has no ghost peers and relays again", "restart", async () => {
		const before = await t.webSocket("/hub/restart");
		await before.next();
		await before.close();
		await t.restart();
		const alice = await t.webSocket("/hub/restart");
		assert.deepEqual(initOf(await alice.next()), { type: "init-connection", peerCount: 0 });
		const bob = await t.webSocket("/hub/restart");
		assert.deepEqual(initOf(await bob.next()), { type: "init-connection", peerCount: 1 });
		alice.send(JSON.stringify({ type: "back" }));
		assert.equal(JSON.parse(await bob.next()).type, "back");
		await alice.close();
		await bob.close();
	});
};

export default scenario;
