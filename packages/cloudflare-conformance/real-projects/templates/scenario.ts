import assert from "node:assert/strict";

import type { Scenario, TestSocket } from "../../src/real-projects/scenario.js";

interface ChatMessage {
	id: string;
	content: string;
	user: string;
	role: "user" | "assistant";
}

// The client's usePartySocket({ party: "chat", room }) connects to this path.
const roomPath = (room: string, client: string) => `/parties/chat/${room}?_pk=${client}`;

// The server sends the whole history as its first message.
async function join(t: Parameters<Scenario>[0], room: string, client: string): Promise<{ socket: TestSocket; history: ChatMessage[] }> {
	const socket = await t.webSocket(roomPath(room, client));
	const first = JSON.parse(await socket.until((text) => text.includes('"type":"all"'))) as { messages: ChatMessage[] };
	return { socket, history: first.messages };
}

const scenario: Scenario = async (t) => {
	await t.step("serves the chat page and its client bundle", "http", async () => {
		assert.match(await t.text("/"), /id="root"/);
		assert.match(await t.text("/dist/index.js"), /usePartySocket/);
	});

	await t.step("two clients in a room see each other's messages", "websocket", async () => {
		const alice = await join(t, "lobby", "alice");
		const bob = await join(t, "lobby", "bob");
		assert.deepEqual(alice.history, []);
		assert.deepEqual(bob.history, []);
		alice.socket.send(JSON.stringify({ type: "add", id: "m1", content: "hello", user: "Alice", role: "user" }));
		const seen = JSON.parse(await bob.socket.until((text) => text.includes('"id":"m1"')));
		assert.equal(seen.content, "hello");
		assert.equal(seen.user, "Alice");
		await alice.socket.close();
		await bob.socket.close();
	});

	await t.step("a later client gets the history, an update replaces the message, and rooms are separate", "do-state", async () => {
		const carol = await join(t, "lobby", "carol");
		assert.deepEqual(carol.history.map((message) => [message.id, message.content, message.user]), [["m1", "hello", "Alice"]]);
		carol.socket.send(JSON.stringify({ type: "update", id: "m1", content: "hello edited", user: "Alice", role: "user" }));
		await carol.socket.until((text) => text.includes('"type":"update"'));
		await carol.socket.close();
		const dave = await join(t, "lobby", "dave");
		assert.deepEqual(dave.history.map((message) => [message.id, message.content, message.user]), [["m1", "hello edited", "Alice"]]);
		await dave.socket.close();
		const other = await join(t, "other-room", "erin");
		assert.deepEqual(other.history, []);
		await other.socket.close();
	});

	await t.step("a socket stays open while the room hibernates, and a message wakes it", "sleep", async () => {
		const eve = await join(t, "lobby", "eve");
		await t.waitForSleep();
		eve.socket.send(JSON.stringify({ type: "add", id: "m2", content: "still here", user: "Eve", role: "user" }));
		await eve.socket.until((text) => text.includes('"id":"m2"'));
		await eve.socket.close();
	});

	await t.step("a room sleeps, and the history comes back from SQLite when it wakes", "sleep", async () => {
		await t.waitForSleep();
		const frank = await join(t, "lobby", "frank");
		assert.ok(frank.history.some((message) => message.id === "m1" && message.content === "hello edited"));
		await frank.socket.close();
	});

	await t.step("the history survives an orange dev and engine restart", "restart", async () => {
		await t.restart();
		const grace = await join(t, "lobby", "grace");
		assert.ok(grace.history.some((message) => message.id === "m1" && message.content === "hello edited"));
		await grace.socket.close();
	});
};

export default scenario;
