import assert from "node:assert/strict";

import type { Scenario, TestSocket } from "../../src/real-projects/scenario.js";

const room = "budget";
const ofType = (type: string) => (text: string) => (JSON.parse(text) as { type: string }).type === type;

const scenario: Scenario = async (t) => {
	const value = async (cell: string): Promise<unknown> =>
		(await t.json<{ datavalue: unknown }>(`/_/${room}/cells/${cell}`)).datavalue;
	const command = async (commandText: string): Promise<void> => {
		const response = await t.fetch(`/_/${room}`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ command: commandText }),
		});
		assert.equal(response.status, 202, await response.text());
	};
	const join = (user: string): Promise<TestSocket> => t.webSocket(`/_ws/${room}?user=${user}`);
	const askLog = async (socket: TestSocket, user: string) => {
		socket.send(JSON.stringify({ type: "ask.log", room, user }));
		return JSON.parse(await socket.until(ofType("log"))) as { log: string[]; chat: string[]; snapshot: string };
	};

	await t.step("the app page is served, and /_new sends a user to a new sheet", "http", async () => {
		assert.match(await t.text("/_start"), /EtherCalc/i);
		const response = await t.fetch("/_new");
		assert.equal(response.status, 302);
		assert.match(response.headers.get("location") ?? "", /^\/[a-z0-9]+/);
	});

	await t.step("commands write cells, a formula recalculates, and CSV export sees them", "do-state", async () => {
		await command("set A1 value n 1");
		await command("set A2 formula A1+41");
		assert.equal(await value("A1"), 1);
		assert.equal(await value("A2"), 42);
		assert.match(await t.text(`/_/${room}/csv`), /1[\s\S]*42/);
	});

	await t.step("two clients get the sheet log, and edits and chat reach the other client", "websocket", async () => {
		const alice = await join("alice");
		const bob = await join("bob");
		const { snapshot } = await askLog(alice, "alice");
		assert.match(snapshot, /cell:A2/);
		await askLog(bob, "bob");
		alice.send(JSON.stringify({ type: "execute", room, user: "alice", cmdstr: "set B1 value n 7" }));
		const edit = JSON.parse(await bob.until(ofType("execute"))) as { user: string; cmdstr: string };
		assert.equal(edit.user, "alice");
		assert.equal(edit.cmdstr, "set B1 value n 7");
		bob.send(JSON.stringify({ type: "chat", room, user: "bob", msg: "got it" }));
		const chat = JSON.parse(await alice.until(ofType("chat"))) as { user: string; msg: string };
		assert.deepEqual([chat.user, chat.msg], ["bob", "got it"]);
		assert.equal(await value("B1"), 7);
		await alice.close();
		await bob.close();
	});

	await t.step("a client that joins later gets the edits and the chat from the log", "do-state", async () => {
		const carol = await join("carol");
		const { chat, snapshot } = await askLog(carol, "carol");
		assert.match(snapshot, /cell:B1/);
		assert.ok(chat.some((line) => line.includes("got it")), `chat: ${chat.join(" | ")}`);
		await carol.close();
	});

	await t.step("two sockets stay open while the room hibernates, and an edit wakes it", "sleep", async () => {
		const alice = await join("alice");
		const bob = await join("bob");
		await t.waitForSleep(60_000);
		alice.send(JSON.stringify({ type: "execute", room, user: "alice", cmdstr: "set C1 value n 9" }));
		const edit = JSON.parse(await bob.until(ofType("execute"))) as { cmdstr: string };
		assert.equal(edit.cmdstr, "set C1 value n 9");
		await alice.close();
		await bob.close();
	});

	await t.step("cells and formulas survive the room's sleep", "sleep", async () => {
		await t.waitForSleep(60_000);
		assert.equal(await value("A2"), 42);
		assert.equal(await value("B1"), 7);
		await command("set A1 value n 2");
		assert.equal(await value("A2"), 43);
	});

	await t.step("the sheet and chat survive an orange dev and engine restart", "restart", async () => {
		await t.restart();
		assert.equal(await value("A2"), 43);
		const dave = await join("dave");
		const { chat } = await askLog(dave, "dave");
		assert.ok(chat.some((line) => line.includes("got it")), `chat: ${chat.join(" | ")}`);
		await dave.close();
	});
};

export default scenario;
