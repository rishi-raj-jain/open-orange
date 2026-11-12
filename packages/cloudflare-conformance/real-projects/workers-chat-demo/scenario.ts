import assert from "node:assert/strict";

import type { Scenario } from "../../src/real-projects/scenario.js";

const scenario: Scenario = async (t) => {
	await t.step("serves the chat page", "http", async () => {
		assert.match(await t.text("/"), /id="chatlog"/);
	});

	await t.step("two clients chat in a room, and history is kept", "websocket", async () => {
		const alice = await t.webSocket("/api/room/lobby/websocket");
		alice.send(JSON.stringify({ name: "alice" }));
		await alice.until((text) => text.includes('"ready":true'));
		const bob = await t.webSocket("/api/room/lobby/websocket");
		bob.send(JSON.stringify({ name: "bob" }));
		await bob.until((text) => text.includes('"ready":true'));
		// The demo's rate limiter refuses a message until its first check returns.
		await t.delay(500);
		alice.send(JSON.stringify({ message: "hello" }));
		const seen = JSON.parse(await bob.until((text) => text.includes('"message":"hello"')));
		assert.equal(seen.name, "alice");
		await alice.close();
		await bob.close();
	});

	await t.step("a socket stays open while the room hibernates, and a message wakes it", "sleep", async () => {
		const eve = await t.webSocket("/api/room/lobby/websocket");
		eve.send(JSON.stringify({ name: "eve" }));
		await eve.until((text) => text.includes('"ready":true'));
		await t.waitForSleep();
		eve.send(JSON.stringify({ message: "still here" }));
		await eve.until((text) => text.includes('"message":"still here"'));
		await eve.close();
	});

	await t.step("a room sleeps, and the history comes back after it wakes", "sleep", async () => {
		await t.waitForSleep();
		const carol = await t.webSocket("/api/room/lobby/websocket");
		carol.send(JSON.stringify({ name: "carol" }));
		await carol.until((text) => text.includes('"message":"hello"'));
		await carol.close();
	});

	await t.step("the history survives an orange dev and engine restart", "restart", async () => {
		await t.restart();
		const dave = await t.webSocket("/api/room/lobby/websocket");
		dave.send(JSON.stringify({ name: "dave" }));
		await dave.until((text) => text.includes('"message":"hello"'));
		await dave.close();
	});
};

export default scenario;
