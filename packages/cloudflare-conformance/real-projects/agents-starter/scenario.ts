import assert from "node:assert/strict";

import type { Scenario, TestSocket } from "../../src/real-projects/scenario.js";

// The app's useAgent({ agent: "ChatAgent" }) connects to the default instance.
const agent = "/agents/chat-agent/default";

function chatMessage(id: string, text: string) {
	return { id, role: "user", parts: [{ type: "text", text }] };
}

const scenario: Scenario = async (t) => {
	const hasType = (type: string) => (text: string) => (JSON.parse(text) as { type: string }).type === type;
	const rpc = async (socket: TestSocket, id: string, method: string, args: unknown[]) => {
		socket.send(JSON.stringify({ type: "rpc", id, method, args }));
		return JSON.parse(
			await socket.until((text) => {
				const message = JSON.parse(text) as { type: string; id?: string };
				return message.type === "rpc" && message.id === id;
			}),
		) as { success: boolean; error?: string };
	};
	const storedMessages = async () =>
		(await t.json<{ id: string; parts: { text: string }[] }[]>(`${agent}/get-messages`)).map((message) => message.id);

	await t.step("a client gets its identity and the MCP server list on connect", "websocket", async () => {
		const socket = await t.webSocket(agent);
		const identity = JSON.parse(await socket.until(hasType("cf_agent_identity"))) as { name: string; agent: string };
		assert.deepEqual([identity.name, identity.agent], ["default", "chat-agent"]);
		await socket.until(hasType("cf_agent_mcp_servers"));
		await socket.close();
	});

	await t.step("messages one client sets reach the other client and are stored", "websocket", async () => {
		const alice = await t.webSocket(agent);
		await alice.until(hasType("cf_agent_mcp_servers"));
		const bob = await t.webSocket(agent);
		await bob.until(hasType("cf_agent_mcp_servers"));
		alice.send(JSON.stringify({ type: "cf_agent_chat_messages", messages: [chatMessage("m1", "hello")] }));
		const seen = await bob.until((text) => hasType("cf_agent_chat_messages")(text) && text.includes('"m1"'));
		assert.match(seen, /hello/);
		assert.deepEqual(await storedMessages(), ["m1"]);
		await alice.close();
		await bob.close();
	});

	await t.step("a client calls a callable method, and a method without the decorator is refused", "do-state", async () => {
		const socket = await t.webSocket(agent);
		assert.equal((await rpc(socket, "r1", "removeServer", ["no-such-server"])).success, true);
		const refused = await rpc(socket, "r2", "executeTask", ["x"]);
		assert.equal(refused.success, false);
		assert.match(refused.error ?? "", /is not callable/);
		await socket.close();
	});

	await t.step("the agent sleeps, and the messages come back from SQLite", "sleep", async () => {
		await t.waitForSleep();
		assert.deepEqual(await storedMessages(), ["m1"]);
	});

	await t.step("a client stays connected while the agent hibernates, and its next call is answered", "sleep", async () => {
		await t.waitForSleep();
		const socket = await t.webSocket(agent);
		await socket.until(hasType("cf_agent_mcp_servers"));
		await t.waitForSleep();
		assert.equal((await rpc(socket, "r3", "removeServer", ["no-such-server"])).success, true);
		await socket.close();
	});

	await t.step("the messages survive an orange dev and engine restart", "restart", async () => {
		await t.restart();
		assert.deepEqual(await storedMessages(), ["m1"]);
	});

	t.needsSecrets("the assistant answers a chat message through Workers AI, and its tools schedule a task", "binding", [
		"CLOUDFLARE_API_TOKEN",
	]);
};

export default scenario;
