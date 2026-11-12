import assert from "node:assert/strict";

import type { Scenario, TestSocket } from "../../src/real-projects/scenario.js";

// The messages of src/net/CloudflareWorkerEthernetProvider.ts.
const scenario: Scenario = async (t) => {
	const join = async (zone: string, macAddress: string): Promise<TestSocket> => {
		const socket = await t.webSocket(`/zone/${zone}/websocket`);
		socket.send(JSON.stringify({ type: "init", macAddress }));
		return socket;
	};
	const send = (socket: TestSocket, destination: string, packetArray: number[]) =>
		socket.send(JSON.stringify({ type: "send", destination, packetArray }));
	const receive = async (socket: TestSocket): Promise<unknown> => JSON.parse(await socket.next());
	const macsIn = async (zone: string): Promise<string[]> => {
		const body = await t.text(`/zone/${zone}/list`);
		const clients = JSON.parse(body.replace(/^clients: /, "")) as { macAddress: string }[];
		return clients.map((client) => client.macAddress).sort();
	};
	const waitForMacs = async (zone: string, macs: string[]): Promise<void> => {
		const deadline = Date.now() + 10_000;
		let seen = await macsIn(zone);
		while (JSON.stringify(seen) !== JSON.stringify(macs)) {
			if (Date.now() > deadline) assert.deepEqual(seen, macs);
			await t.delay(50);
			seen = await macsIn(zone);
		}
	};

	await t.step("machines stay on the network across the zone's hibernation, and a packet wakes it", "sleep", async () => {
		// First step of the run: KV is an actor too, and waitForSleep returns on any actor's sleep.
		const alice = await join("sleepy", "aa:00");
		const bob = await join("sleepy", "bb:00");
		await waitForMacs("sleepy", ["aa:00", "bb:00"]);
		await t.waitForSleep();
		send(alice, "bb:00", [1, 2, 3]);
		assert.deepEqual(await receive(bob), { type: "receive", packetArray: [1, 2, 3] });
		await alice.close();
		await bob.close();
	});

	await t.step("a packet reaches its MAC address only, and a broadcast reaches the others", "websocket", async () => {
		const alice = await join("lan", "aa:01");
		const bob = await join("lan", "bb:01");
		const carol = await join("lan", "cc:01");
		await waitForMacs("lan", ["aa:01", "bb:01", "cc:01"]);
		send(alice, "bb:01", [10]);
		assert.deepEqual(await receive(bob), { type: "receive", packetArray: [10] });
		send(alice, "*", [11]);
		assert.deepEqual(await receive(bob), { type: "receive", packetArray: [11] });
		// Carol got no direct packet: her first message is the broadcast. Alice gets no copy.
		assert.deepEqual(await receive(carol), { type: "receive", packetArray: [11] });
		send(bob, "AT", [12]);
		assert.deepEqual(await receive(alice), { type: "receive", packetArray: [12] });
		await alice.close();
		await bob.close();
		await carol.close();
	});

	await t.step("a machine that asks to close leaves the zone's list, and zones are separate", "do-state", async () => {
		const alice = await join("office", "aa:02");
		const bob = await join("office", "bb:02");
		const other = await join("home", "dd:02");
		await waitForMacs("office", ["aa:02", "bb:02"]);
		await waitForMacs("home", ["dd:02"]);
		bob.send(JSON.stringify({ type: "close" }));
		await waitForMacs("office", ["aa:02"]);
		await alice.close();
		await other.close();
		await bob.close();
	});

	await t.step("a machine that sends close and closes its socket, as the client does, leaves the list", "websocket", async () => {
		const alice = await join("cafe", "aa:04");
		const bob = await join("cafe", "bb:04");
		await waitForMacs("cafe", ["aa:04", "bb:04"]);
		bob.send(JSON.stringify({ type: "close" }));
		await bob.close();
		await waitForMacs("cafe", ["aa:04"]);
		await alice.close();
	});

	await t.step("varz counters add up in KV", "binding", async () => {
		const count = (delta: number) =>
			t.fetch("/varz", { method: "POST", body: JSON.stringify({ emulator_starts: delta }) });
		assert.equal((await count(2)).status, 204);
		assert.equal((await count(3)).status, 204);
		assert.equal(await t.json("/varz?name=emulator_starts"), 5);
	});

	await t.step("varz survive a restart, and a zone relays after it", "restart", async () => {
		await t.restart();
		assert.equal(await t.json("/varz?name=emulator_starts"), 5);
		const alice = await join("after", "aa:03");
		const bob = await join("after", "bb:03");
		await waitForMacs("after", ["aa:03", "bb:03"]);
		send(alice, "*", [20]);
		assert.deepEqual(await receive(bob), { type: "receive", packetArray: [20] });
		await alice.close();
		await bob.close();
	});
};

export default scenario;
