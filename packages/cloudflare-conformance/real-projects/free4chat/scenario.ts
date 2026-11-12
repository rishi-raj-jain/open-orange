import assert from "node:assert/strict";

import type { Scenario, ScenarioContext } from "../../src/real-projects/scenario.js";

interface Handle {
	room: string;
	participantId: string;
	participantToken: string;
}

interface Joined {
	participantHandle: string;
	cursor: number;
	invite?: { roomId: string };
}

// Agents use the Room through MCP tools at /mcp. The 2026-07-28 revision has no initialize handshake:
// each call carries this envelope and headers, as agent/internal/free4chat/client.go sends them.
const protocolVersion = "2026-07-28";
let nextId = 0;
async function rpc(t: ScenarioContext, method: string, params: Record<string, unknown>, name?: string): Promise<any> {
	const response = await t.fetch("/mcp", {
		method: "POST",
		headers: {
			"content-type": "application/json",
			accept: "application/json, text/event-stream",
			"MCP-Protocol-Version": protocolVersion,
			"Mcp-Method": method,
			...(name === undefined ? {} : { "Mcp-Name": name }),
		},
		body: JSON.stringify({
			jsonrpc: "2.0",
			id: ++nextId,
			method,
			params: {
				...params,
				_meta: {
					"io.modelcontextprotocol/protocolVersion": protocolVersion,
					"io.modelcontextprotocol/clientCapabilities": {},
				},
			},
		}),
	});
	const body = await response.text();
	assert.equal(response.status, 200, body.slice(0, 400));
	const data = body.startsWith("{") ? body : body.split("\n").find((line) => line.startsWith("data: "))?.slice(6);
	assert.ok(data, `no JSON-RPC message in: ${body.slice(0, 400)}`);
	const message = JSON.parse(data) as { result?: unknown; error?: unknown };
	if (message.error !== undefined) throw new Error(`${method}: ${JSON.stringify(message.error)}`);
	return message.result;
}

async function tool<T = any>(t: ScenarioContext, name: string, args: Record<string, unknown>): Promise<T> {
	const result = await rpc(t, "tools/call", { name, arguments: args }, name) as { content: { text: string }[]; isError?: boolean };
	const text = result.content[0]!.text;
	if (result.isError === true) throw new Error(`${name}: ${text}`);
	return JSON.parse(text) as T;
}

const decodeHandle = (value: string) => JSON.parse(Buffer.from(value, "base64url").toString("utf8")) as Handle;

// The resident Runtime opens this socket with these headers (agent/internal/free4chat/resident_events.go).
function eventSocket(t: ScenarioContext, value: string, cursor: number) {
	const handle = decodeHandle(value);
	return t.webSocket("/api/room/agent-events", {
		headers: {
			"X-Room-Id": handle.room,
			"X-Room-Participant-Id": handle.participantId,
			"X-Room-Cursor": String(cursor),
			authorization: `Bearer ${handle.participantToken}`,
		},
	});
}

const scenario: Scenario = async (t) => {
	await t.step("serves the Next.js home page and the Agent protocol document", "http", async () => {
		assert.match(await t.text("/"), /<html/);
		assert.match(await t.text("/agent.md"), /Free4Chat Agent Room Protocol/);
	});

	let alice: Joined;
	let bob: Joined;
	let roomId = "";
	await t.step("one Agent creates a Room, another joins it, and the Room lists both", "do-state", async () => {
		const { tools } = await rpc(t, "tools/list", {}) as { tools: { name: string }[] };
		assert.ok(tools.some((listed) => listed.name === "create_room"));
		alice = await tool<Joined>(t, "create_room", { name: "Alice", capabilities: ["code.edit"] });
		roomId = alice.invite!.roomId;
		bob = await tool<Joined>(t, "join_room", { roomId, name: "Bob" });
		const info = await tool<{ participants: { name: string }[] }>(t, "room_info", { roomId });
		assert.deepEqual(info.participants.map((participant) => participant.name).sort(), ["Alice", "Bob"]);
	});

	await t.step("a message from one Agent reaches the other through wait_for_events", "do-state", async () => {
		await tool(t, "send_text", { participantHandle: alice.participantHandle, text: "hello bob" });
		const events = await tool(t, "wait_for_events", { participantHandle: bob.participantHandle, cursor: bob.cursor, timeoutSeconds: 0 });
		assert.match(JSON.stringify(events), /hello bob/);
	});

	await t.step("a resident Agent's event socket gets a message as it is sent", "websocket", async () => {
		const socket = await eventSocket(t, bob.participantHandle, bob.cursor);
		await tool(t, "send_text", { participantHandle: alice.participantHandle, text: "over the socket" });
		await socket.until((text) => text.includes("over the socket"));
		await socket.close();
	});

	await t.step("a resident Agent's event socket stays open while the Room hibernates, and a message wakes it", "sleep", async () => {
		await t.waitForSleep();
		const socket = await eventSocket(t, bob.participantHandle, bob.cursor);
		await t.waitForSleep();
		await tool(t, "send_text", { participantHandle: alice.participantHandle, text: "after hibernation" });
		await socket.until((text) => text.includes("after hibernation"));
		await socket.close();
	});

	await t.step("a Room sleeps, and its shared context comes back when it wakes", "sleep", async () => {
		await t.waitForSleep();
		const context = await tool(t, "read_room_context", { participantHandle: alice.participantHandle });
		assert.match(JSON.stringify(context), /hello bob/);
	});

	await t.step("the shared context survives a restart", "restart", async () => {
		await t.restart();
		const context = await tool(t, "read_room_context", { participantHandle: alice.participantHandle });
		assert.match(JSON.stringify(context), /hello bob/);
	});

	t.needsSecrets("a Human joins a Room with realtime media", "binding", ["SFU_APP_ID", "SFU_APP_SECRET"]);
};

export default scenario;
