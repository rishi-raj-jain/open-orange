import assert from "node:assert/strict";

import type { Scenario } from "../../src/real-projects/scenario.js";

// The signaling calls of file-transfer-web/src/services/signaling.ts.
const scenario: Scenario = async (t) => {
	const createGroup = async (groupName: string, password?: string): Promise<string> => {
		const created = await t.json<{ groupCode: string; groupName: string }>("/api/group", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ groupName, password, creatorDeviceId: "aaaaaaaaaaaa" }),
		});
		assert.equal(created.groupName, groupName);
		assert.match(created.groupCode, /^[A-Z2-9]{6}$/);
		return created.groupCode;
	};
	const socketPath = (code: string, deviceId: string, deviceName: string, password?: string): string => {
		const params = new URLSearchParams({ deviceId, deviceName, lanIp: "" });
		if (password !== undefined) params.set("password", password);
		return `/ws/group/${code}?${params}`;
	};
	const ofType = (type: string) => (text: string) => (JSON.parse(text) as { type: string }).type === type;

	let kept = "";

	await t.step("a created group is found by code, and an unknown code is not", "do-state", async () => {
		kept = await createGroup("Kept group");
		const info = await t.json<{ groupName: string; peerCount: number }>(`/api/group/${kept}`);
		assert.equal(info.groupName, "Kept group");
		assert.equal(info.peerCount, 0);
		await t.json("/api/group/ZZZZZZ", undefined, 404);
	});

	await t.step("a password group refuses the wrong password", "do-state", async () => {
		const code = await createGroup("Private group", "right");
		await assert.rejects(t.webSocket(socketPath(code, "bbbbbbbbbbbb", "Mallory", "wrong")), /HTTP 403/);
		const device = await t.webSocket(socketPath(code, "cccccccccccc", "Carol", "right"));
		const joined = JSON.parse(await device.until(ofType("joined"))) as { groupName: string };
		assert.equal(joined.groupName, "Private group");
		await device.close();
	});

	let code = "";
	await t.step("two devices join and see each other", "websocket", async () => {
		code = await createGroup("Devices");
		const alice = await t.webSocket(socketPath(code, "a11ce0000000", "Alice"));
		const aliceJoined = JSON.parse(await alice.until(ofType("joined"))) as { peers: unknown[] };
		assert.deepEqual(aliceJoined.peers, []);
		const bob = await t.webSocket(socketPath(code, "b0b000000000", "Bob"));
		const bobJoined = JSON.parse(await bob.until(ofType("joined"))) as { peers: { deviceName: string }[] };
		assert.deepEqual(bobJoined.peers.map((peer) => peer.deviceName), ["Alice"]);
		const announced = JSON.parse(await alice.until(ofType("device-joined"))) as { device: { deviceName: string } };
		assert.equal(announced.device.deviceName, "Bob");
		const info = await t.json<{ peerCount: number }>(`/api/group/${code}`);
		assert.equal(info.peerCount, 2);
		await alice.close();
		await bob.close();
	});

	await t.step("an SDP offer sent on one device's socket reaches the other device", "websocket", async () => {
		const relay = await createGroup("Relay");
		const alice = await t.webSocket(socketPath(relay, "a11ce0000000", "Alice"));
		await alice.until(ofType("joined"));
		const bob = await t.webSocket(socketPath(relay, "b0b000000000", "Bob"));
		await bob.until(ofType("joined"));
		await alice.until(ofType("device-joined"));
		alice.send(JSON.stringify({ type: "sdp-offer", to: "b0b000000000", sdp: "v=0" }));
		const offer = JSON.parse(await bob.until(ofType("sdp-offer"))) as { from: string; sdp: string };
		assert.deepEqual([offer.from, offer.sdp], ["a11ce0000000", "v=0"]);
		await alice.close();
		await bob.close();
	});

	await t.step("a group survives the object's sleep", "sleep", async () => {
		await t.waitForSleep();
		const info = await t.json<{ groupName: string }>(`/api/group/${kept}`);
		assert.equal(info.groupName, "Kept group");
	});

	await t.step("a group survives an orange dev and engine restart", "restart", async () => {
		await t.restart();
		const info = await t.json<{ groupName: string }>(`/api/group/${kept}`);
		assert.equal(info.groupName, "Kept group");
	});
};

export default scenario;
