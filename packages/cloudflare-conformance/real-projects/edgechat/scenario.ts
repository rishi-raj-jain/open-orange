import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";

import type { Scenario, TestSocket } from "../../src/real-projects/scenario.js";

const ofType = (type: string) => (text: string) => (JSON.parse(text) as { type: string }).type === type;
const says = (content: string) => (text: string) => {
	const packet = JSON.parse(text) as { type: string; message?: { content?: string } };
	return packet.type === "message" && packet.message?.content === content;
};

const scenario: Scenario = async (t) => {
	const login = async (username: string, password: string): Promise<string> => {
		const { token } = await t.json<{ token: string }>("/api/auth/login", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ username, password }),
		});
		return token;
	};
	const as = (token: string): RequestInit => ({
		headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
	});
	const room = async (token: string, generalId: number): Promise<TestSocket> => {
		const socket = await t.webSocket(`/api/ws/public/${generalId}?token=${token}`);
		await socket.until(ofType("ready"));
		return socket;
	};
	const send = (socket: TestSocket, content: string, clientMessageId: string = randomUUID()): string => {
		socket.send(JSON.stringify({ type: "send", clientMessageId, content }));
		return clientMessageId;
	};
	const history = async (token: string, generalId: number): Promise<string[]> => {
		const { messages } = await t.json<{ messages: { content: string }[] }>(
			`/api/messages?kind=public&roomId=${generalId}&limit=100`,
			as(token),
		);
		return messages.map((message) => message.content);
	};

	let adminToken = "";
	let bobToken = "";
	let generalId = 0;

	await t.step("the API answers and the app shell is served", "http", async () => {
		assert.deepEqual(await t.json("/api/health"), { ok: true });
		assert.match(await t.text("/"), /<div id="app"/);
	});

	await t.step("the admin signs in, creates a user, and both see the general channel", "binding", async () => {
		adminToken = await login("admin", "orange-dev-admin");
		await t.json("/api/admin/users", {
			...as(adminToken),
			method: "POST",
			body: JSON.stringify({ username: "bob", password: "bob-local-password" }),
		});
		bobToken = await login("bob", "bob-local-password");
		const { channels } = await t.json<{ channels: { id: number; name: string }[] }>("/api/bootstrap", as(bobToken));
		const general = channels.find((channel) => channel.name === "general");
		assert.ok(general, "bob has no general channel");
		generalId = Number(general.id);
		await assert.rejects(t.webSocket(`/api/ws/public/${generalId}?token=wrong`), /HTTP 401/);
	});

	await t.step("two users chat in a room, a retry is not delivered twice, and history is kept", "websocket", async () => {
		const admin = await room(adminToken, generalId);
		const bob = await room(bobToken, generalId);
		const id = send(admin, "hello bob");
		await bob.until(says("hello bob"));
		await admin.until(says("hello bob"));
		send(admin, "hello bob", id);
		await admin.until(says("hello bob"));
		send(bob, "hello admin");
		await admin.until(says("hello admin"));
		await bob.until(says("hello admin"));
		assert.deepEqual(await history(bobToken, generalId), ["hello bob", "hello admin"]);
		await admin.close();
		await bob.close();
	});

	await t.step("a user's inbox socket hears about a message in a room they are not viewing", "websocket", async () => {
		const inbox = await t.webSocket(`/api/inbox/ws?token=${bobToken}`);
		await inbox.until(ofType("ready"));
		const admin = await room(adminToken, generalId);
		send(admin, "are you there");
		const notice = JSON.parse(await inbox.until(ofType("room_message"))) as {
			room: { id: number };
			unreadCount: number;
			contentPreview: string;
		};
		assert.equal(notice.room.id, generalId);
		assert.equal(notice.contentPreview, "are you there");
		assert.ok(notice.unreadCount >= 1);
		await admin.close();
		await inbox.close();
	});

	await t.step("two sockets stay open while the room hibernates, and a message wakes it", "sleep", async () => {
		const admin = await room(adminToken, generalId);
		const bob = await room(bobToken, generalId);
		await t.waitForSleep(60_000);
		send(admin, "after hibernation");
		await bob.until(says("after hibernation"));
		await admin.close();
		await bob.close();
	});

	await t.step("after the room sleeps, a new socket chats and the history is there", "sleep", async () => {
		await t.waitForSleep(60_000);
		const bob = await room(bobToken, generalId);
		send(bob, "after sleep");
		await bob.until(says("after sleep"));
		await bob.close();
		const contents = await history(adminToken, generalId);
		assert.ok(contents.includes("hello bob") && contents.includes("after sleep"), `history: ${contents.join(", ")}`);
	});

	await t.step("the session and history survive an orange dev and engine restart, and the room works", "restart", async () => {
		await t.restart();
		const contents = await history(bobToken, generalId);
		assert.ok(contents.includes("hello bob"), `history: ${contents.join(", ")}`);
		const admin = await room(adminToken, generalId);
		const bob = await room(bobToken, generalId);
		send(admin, "after restart");
		await bob.until(says("after restart"));
		await admin.close();
		await bob.close();
	});
};

export default scenario;
