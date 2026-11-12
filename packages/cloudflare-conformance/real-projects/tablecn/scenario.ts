import assert from "node:assert/strict";

import type { Scenario, ScenarioContext, TestSocket } from "../../src/real-projects/scenario.js";

const room = "/parties/main/lobby";

interface Row {
	id: string;
	name: string | null;
}
interface ServerMessage {
	type: string;
	rows?: Row[];
	userId?: string;
	reason?: string;
	mutationId?: string;
	updates?: { rowId: string; columnId: string; value: unknown }[];
	ids?: string[];
}

function newRow(id: string) {
	return {
		id,
		order: 100,
		name: "Elissa Steamer",
		email: null,
		stance: "regular",
		style: "street",
		status: "legend",
		yearsSkating: null,
		startedSkating: null,
		isPro: true,
		tricks: null,
		media: null,
		createdAt: new Date().toISOString(),
		updatedAt: null,
	};
}

const scenario: Scenario = async (t) => {
	const until = async (socket: TestSocket, type: string, match: (message: ServerMessage) => boolean = () => true) =>
		JSON.parse(
			await socket.until((text) => {
				const message = JSON.parse(text) as ServerMessage;
				return message.type === type && match(message);
			}),
		) as ServerMessage;
	const join = async (context: ScenarioContext, clientId: string) => {
		const socket = await context.webSocket(`${room}?clientId=${clientId}&name=${clientId}`);
		const snapshot = await until(socket, "snapshot");
		return { socket, rows: snapshot.rows ?? [] };
	};

	let firstRow = "";
	let seedRowIds: string[] = [];

	await t.step("a second client gets the same seeded rows, and the first sees it join", "websocket", async () => {
		const alice = await join(t, "alice");
		assert.equal(alice.rows.length, 20);
		firstRow = alice.rows[0]!.id;
		seedRowIds = alice.rows.map((row) => row.id);
		const bob = await join(t, "bob");
		assert.deepEqual(bob.rows.map((row) => row.id), seedRowIds);
		assert.equal((await until(alice.socket, "user-join")).userId, "bob");
		await alice.socket.close();
		assert.equal((await until(bob.socket, "user-leave")).userId, "alice");
		await bob.socket.close();
	});

	await t.step("edits and added and deleted rows reach the other client and are acknowledged", "websocket", async () => {
		const alice = await join(t, "alice");
		const bob = await join(t, "bob");
		alice.socket.send(
			JSON.stringify({
				type: "cells-update",
				mutationId: "m1",
				updates: [{ rowId: firstRow, columnId: "name", value: "Tony Hawk" }],
			}),
		);
		await until(alice.socket, "ack", (message) => message.mutationId === "m1");
		const update = await until(bob.socket, "cells-update");
		assert.equal(update.userId, "alice");
		assert.equal(update.updates?.[0]?.value, "Tony Hawk");

		alice.socket.send(JSON.stringify({ type: "rows-add", mutationId: "m2", rows: [newRow("scenario-row")] }));
		await until(alice.socket, "ack", (message) => message.mutationId === "m2");
		const added = await until(bob.socket, "rows-add");
		assert.equal(added.rows?.[0]?.id, "scenario-row");

		alice.socket.send(JSON.stringify({ type: "rows-delete", mutationId: "m3", ids: [seedRowIds[1]] }));
		await until(alice.socket, "ack", (message) => message.mutationId === "m3");
		assert.deepEqual((await until(bob.socket, "rows-delete")).ids, [seedRowIds[1]]);

		await alice.socket.close();
		await bob.socket.close();
	});

	await t.step("the room refuses an invalid value, and the row keeps its value", "do-state", async () => {
		const alice = await join(t, "alice");
		alice.socket.send(
			JSON.stringify({
				type: "cells-update",
				mutationId: "m4",
				updates: [{ rowId: firstRow, columnId: "stance", value: "sideways" }],
			}),
		);
		const rejected = await until(alice.socket, "reject");
		assert.equal(rejected.reason, "Invalid value for stance");
		await alice.socket.close();
		const carol = await join(t, "carol");
		assert.notEqual(
			(carol.rows.find((row) => row.id === firstRow) as unknown as { stance: string }).stance,
			"sideways",
		);
		await carol.socket.close();
	});

	const assertEditsKept = (rows: Row[]) => {
		assert.equal(rows.find((row) => row.id === firstRow)?.name, "Tony Hawk");
		assert.ok(rows.some((row) => row.id === "scenario-row"), "the added row is kept");
		assert.ok(!rows.some((row) => row.id === seedRowIds[1]), "the deleted row stays deleted");
	};

	await t.step("the room sleeps, and the edits come back from its storage", "sleep", async () => {
		await t.waitForSleep();
		const dave = await join(t, "dave");
		assertEditsKept(dave.rows);
		await dave.socket.close();
	});

	await t.step("a client stays connected while the room hibernates, and its next edit is acknowledged", "sleep", async () => {
		await t.waitForSleep();
		const erin = await join(t, "erin");
		await t.waitForSleep();
		erin.socket.send(
			JSON.stringify({
				type: "cells-update",
				mutationId: "m5",
				updates: [{ rowId: firstRow, columnId: "email", value: "erin@example.com" }],
			}),
		);
		await until(erin.socket, "ack", (message) => message.mutationId === "m5");
		await erin.socket.close();
	});

	await t.step("the edits survive an orange dev and engine restart", "restart", async () => {
		await t.restart();
		const frank = await join(t, "frank");
		assertEditsKept(frank.rows);
		await frank.socket.close();
	});
};

export default scenario;
