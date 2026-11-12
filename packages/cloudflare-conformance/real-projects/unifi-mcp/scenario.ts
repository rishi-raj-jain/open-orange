import assert from "node:assert/strict";

import type { Scenario, TestSocket } from "../../src/real-projects/scenario.js";

const admin = { Authorization: "Bearer local-admin-token", "Content-Type": "application/json" };
const agent = { Authorization: "Bearer local-agent-token", "Content-Type": "application/json" };

const tools = [
	{
		name: "unifi_list_clients",
		description: "List the clients on the network",
		annotations: { readOnlyHint: true },
	},
	{
		name: "unifi_block_client",
		description: "Block a client",
		annotations: { readOnlyHint: false, destructiveHint: true },
	},
];

interface ToolCall {
	type: "tool_call";
	call_id: string;
	tool_name: string;
	arguments: Record<string, unknown>;
}

const scenario: Scenario = async (t) => {
	let relayToken = "";
	let locationId = "";
	let readOnlyToken = "";

	const rpc = async (headers: Record<string, string>, method: string, params?: unknown) =>
		await t.json("/mcp", {
			method: "POST",
			headers,
			body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, ...(params === undefined ? {} : { params }) }),
		});

	const toolResult = (response: any) => JSON.parse(response.result.content[0].text);

	// What the relay sidecar does when it starts: connect with the bearer, then register its catalog.
	const connectRelay = async (): Promise<TestSocket> => {
		const relay = await t.webSocket("/ws", { headers: { Authorization: `Bearer ${relayToken}` } });
		relay.send(
			JSON.stringify({
				type: "register",
				protocol_version: 1,
				token: relayToken,
				location_name: "home-lab",
				tools,
				capabilities: [],
			}),
		);
		const registered = JSON.parse(await relay.until((text) => text.includes('"registered"')));
		assert.equal(registered.location_id, locationId);
		return relay;
	};

	// The agent's call waits on the relay's answer, so both run at once.
	const callThroughRelay = async (relay: TestSocket, tool: string, answer: (call: ToolCall) => object) => {
		const agentCall = rpc(agent, "tools/call", { name: "unifi_execute", arguments: { tool, arguments: { site: "default" } } });
		const call = JSON.parse(await relay.until((text) => text.includes('"tool_call"'))) as ToolCall;
		assert.equal(call.tool_name, tool);
		assert.deepEqual(call.arguments, { site: "default" });
		relay.send(JSON.stringify({ type: "tool_result", call_id: call.call_id, ...answer(call) }));
		return await agentCall;
	};

	const assertCatalogKept = async () => {
		const index = toolResult(await rpc(agent, "tools/call", { name: "unifi_tool_index", arguments: {} }));
		assert.deepEqual(index.data.tools.map((tool: { name: string }) => tool.name).sort(), ["unifi_block_client", "unifi_list_clients"]);
		const { locations } = await t.json("/api/locations", { headers: admin });
		assert.equal(locations.length, 1);
		assert.equal(locations[0].location_name, "home-lab");
	};

	await t.step("health is open, and the admin API and MCP refuse a wrong token", "http", async () => {
		assert.deepEqual(await t.json("/health"), { status: "ok" });
		assert.equal((await t.fetch("/api/locations")).status, 401);
		const refused = await t.fetch("/mcp", {
			method: "POST",
			headers: { Authorization: "Bearer wrong", "Content-Type": "application/json" },
			body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize" }),
		});
		assert.equal(refused.status, 401);
	});

	await t.step("the admin API creates a location, and another request lists it", "do-state", async () => {
		const created = await t.json("/api/locations/token", {
			method: "POST",
			headers: admin,
			body: JSON.stringify({ location_name: "home-lab" }),
		}, 201);
		relayToken = created.token;
		locationId = created.location_id;
		const { locations } = await t.json("/api/locations", { headers: admin });
		assert.deepEqual(
			locations.map((location: { location_id: string; connected: boolean }) => [location.location_id, location.connected]),
			[[locationId, false]],
		);
	});

	await t.step("a relay registers over a WebSocket, and an agent's tool call round-trips through it", "websocket", async () => {
		await assert.rejects(
			t.webSocket("/ws", { headers: { Authorization: "Bearer wrong-relay-token" } }),
			/HTTP 401/,
		);
		const relay = await connectRelay();
		const { locations } = await t.json("/api/locations", { headers: admin });
		assert.equal(locations[0].connected, true);

		const listed = await rpc(agent, "tools/list");
		assert.ok(listed.result.tools.some((tool: { name: string }) => tool.name === "unifi_execute"));

		const answered = await callThroughRelay(relay, "unifi_list_clients", () => ({
			result: { success: true, data: ["aa:bb:cc"] },
		}));
		assert.deepEqual(toolResult(answered), { success: true, data: ["aa:bb:cc"] });

		const failed = await callThroughRelay(relay, "unifi_list_clients", () => ({ error: "controller unreachable" }));
		assert.equal(failed.error.message, "controller unreachable");

		relay.send(JSON.stringify({ type: "heartbeat" }));
		await relay.until((text) => text.includes("heartbeat_ack"));
		await relay.close();
	});

	await t.step("a scoped agent token is stored hashed, and it may not run a write tool", "do-state", async () => {
		const created = await t.json("/api/agent-tokens", {
			method: "POST",
			headers: admin,
			body: JSON.stringify({ name: "reader", read_only: true }),
		}, 201);
		readOnlyToken = created.token;
		const denied = toolResult(
			await rpc({ Authorization: `Bearer ${readOnlyToken}`, "Content-Type": "application/json" }, "tools/call", {
				name: "unifi_execute",
				arguments: { tool: "unifi_block_client" },
			}),
		);
		assert.equal(denied.success, false);
		assert.match(denied.error, /read-only/);
	});

	await t.step("a relay stays connected while the object hibernates, and a tool call wakes it", "sleep", async () => {
		const relay = await connectRelay();
		await t.waitForSleep();
		const answered = await callThroughRelay(relay, "unifi_list_clients", () => ({
			result: { success: true, data: ["after-sleep"] },
		}));
		assert.deepEqual(toolResult(answered), { success: true, data: ["after-sleep"] });
		await relay.close();
	});

	await t.step("the catalog, location, and tokens come back from SQLite after a sleep", "sleep", async () => {
		await t.waitForSleep();
		await assertCatalogKept();
		const { agent_tokens: tokens } = await t.json("/api/agent-tokens", { headers: admin });
		assert.deepEqual(tokens.map((token: { name: string }) => token.name), ["reader"]);
	});

	await t.step("after a restart the data stays, the scoped token works, and the relay reconnects with its token", "restart", async () => {
		await t.restart();
		await assertCatalogKept();
		const index = toolResult(
			await rpc({ Authorization: `Bearer ${readOnlyToken}`, "Content-Type": "application/json" }, "tools/call", {
				name: "unifi_tool_index",
				arguments: {},
			}),
		);
		// A read-only token sees only the tools annotated as read-only.
		assert.deepEqual(index.data.tools.map((tool: { name: string }) => tool.name), ["unifi_list_clients"]);
		const relay = await connectRelay();
		const answered = await callThroughRelay(relay, "unifi_list_clients", () => ({
			result: { success: true, data: ["after-restart"] },
		}));
		assert.deepEqual(toolResult(answered), { success: true, data: ["after-restart"] });
		await relay.close();
	});
};

export default scenario;
