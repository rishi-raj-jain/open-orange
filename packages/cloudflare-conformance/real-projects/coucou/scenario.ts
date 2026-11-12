import assert from "node:assert/strict";

import type { Scenario, TestSocket } from "../../src/real-projects/scenario.js";

const accessKey = "local-only-access-key-for-the-relay-0123456";
const auth = { Authorization: `Bearer ${accessKey}` };
const peerOnline = '{"peer":"online"}';
const peerOffline = '{"peer":"offline"}';

// The same values as the project's tests/behaviour.ts: a 22-character room, a 43-character join proof.
const room = (name: string) => name.padEnd(22, "x");
const proof = (seed: number) => Buffer.from(new Uint8Array(32).fill(seed)).toString("base64url");
const frame = (...bytes: number[]) => new Uint8Array(bytes);

const scenario: Scenario = async (t) => {
	const join = (name: string, role: "pc" | "phone", seed = 1): Promise<TestSocket> =>
		t.webSocket(`/v1/room/${room(name)}?role=${role}`, {
			headers: auth,
			protocols: ["coucou.v1", `coucou.join.${proof(seed)}`],
		});
	const closeOf = async (socket: TestSocket): Promise<string> => {
		const error = await socket.next(15_000).then(
			(message) => new Error(`Expected a close, got: ${message}`),
			(failure: Error) => failure,
		);
		return error.message;
	};

	await t.step("the relay refuses a request without a key, a proof, or a valid room", "http", async () => {
		assert.equal(await t.text("/"), "Coucou link relay");
		const path = `/v1/room/${room("refused")}?role=pc`;
		assert.equal((await t.fetch("/v1/room/short?role=pc", { headers: auth })).status, 404);
		assert.equal((await t.fetch(path)).status, 401);
		assert.equal((await t.fetch(path, { headers: auth })).status, 400);
		const offered = { ...auth, "Sec-WebSocket-Protocol": `coucou.v1, coucou.join.${proof(1)}` };
		assert.equal((await t.fetch(path, { headers: offered })).status, 426);
	});

	await t.step("a computer and a phone find each other, and frames cross unchanged", "websocket", async () => {
		const pc = await join("relay", "pc");
		const phone = await join("relay", "phone");
		assert.equal(await pc.next(), peerOnline);
		assert.equal(await phone.next(), peerOnline);
		pc.send(frame(1, 2, 3, 0, 255));
		assert.deepEqual(new Uint8Array(await phone.nextBytes()), frame(1, 2, 3, 0, 255));
		phone.send(frame(200, 100));
		assert.deepEqual(new Uint8Array(await pc.nextBytes()), frame(200, 100));
		await phone.close();
		assert.equal(await pc.next(), peerOffline);
		pc.send(frame(7));
		assert.equal(await pc.next(), peerOffline);
		await pc.close();
	});

	await t.step("the platform answers the heartbeat, and text frames are refused", "websocket", async () => {
		const pc = await join("heartbeat", "pc");
		pc.send("ping");
		assert.equal(await pc.next(), "pong");
		pc.send("not binary");
		assert.match(await closeOf(pc), /1003 binary only/);
	});

	await t.step("a room held under another key says so and closes", "websocket", async () => {
		const pc = await join("taken", "pc", 1);
		const stranger = await join("taken", "phone", 2);
		assert.match(await closeOf(stranger), /1008 join proof/);
		await pc.close();
	});

	await t.step("a new socket replaces the old one of its role, and the peer stays linked", "websocket", async () => {
		const first = await join("replace", "pc");
		const phone = await join("replace", "phone");
		assert.equal(await first.next(), peerOnline);
		assert.equal(await phone.next(), peerOnline);
		const second = await join("replace", "pc");
		assert.match(await closeOf(first), /1000 replaced/);
		assert.equal(await second.next(), peerOnline);
		// The room tells the peer again, so the phone sees a second "online" and no "offline".
		assert.equal(await phone.next(), peerOnline);
		second.send(frame(4, 5));
		assert.deepEqual(new Uint8Array(await phone.nextBytes()), frame(4, 5));
		await second.close();
		await phone.close();
	});

	await t.step("an idle room hibernates, and the next frame still reaches the peer", "sleep", async () => {
		const pc = await join("hibernate", "pc");
		const phone = await join("hibernate", "phone");
		assert.equal(await pc.next(), peerOnline);
		assert.equal(await phone.next(), peerOnline);
		await t.waitForSleep();
		pc.send("ping");
		assert.equal(await pc.next(), "pong");
		phone.send(frame(42));
		assert.deepEqual(new Uint8Array(await pc.nextBytes()), frame(42));
		await pc.close();
		await phone.close();
	});

	await t.step("after a restart, both sides join again and frames cross", "restart", async () => {
		await t.restart();
		const pc = await join("relay", "pc");
		const phone = await join("relay", "phone");
		assert.equal(await pc.next(), peerOnline);
		assert.equal(await phone.next(), peerOnline);
		pc.send(frame(8));
		assert.deepEqual(new Uint8Array(await phone.nextBytes()), frame(8));
		await pc.close();
		await phone.close();
	});
};

export default scenario;
