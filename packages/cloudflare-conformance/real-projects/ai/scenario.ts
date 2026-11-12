import assert from "node:assert/strict";
import { createServer } from "node:http";

import type { Scenario } from "../../src/real-projects/scenario.js";
import type { TestSocket } from "../../src/real-projects/scenario.js";

const mcpPort = 38918;
const mcpUrl = `http://127.0.0.1:${mcpPort}/mcp`;
const room = "/agents/my-agent/corpus-session";

/** The remote MCP server the demo's README asks the user to start first. Streamable HTTP, JSON replies. */
function startMcpServer() {
	const server = createServer((request, response) => {
		if (request.method !== "POST") {
			response.statusCode = request.method === "DELETE" ? 200 : 405;
			response.end();
			return;
		}
		let text = "";
		request.on("data", (chunk) => (text += chunk));
		request.on("end", () => {
			const message = JSON.parse(text) as { id?: number; method: string; params?: { protocolVersion?: string } };
			if (message.id === undefined) {
				response.statusCode = 202;
				response.end();
				return;
			}
			const results: Record<string, unknown> = {
				initialize: {
					protocolVersion: message.params?.protocolVersion ?? "2025-03-26",
					capabilities: { tools: {} },
					serverInfo: { name: "corpus-mcp", version: "1.0.0" },
				},
				"tools/list": {
					tools: [{ name: "echo", description: "Echoes text", inputSchema: { type: "object", properties: {} } }],
				},
			};
			const result = results[message.method];
			response.setHeader("content-type", "application/json");
			response.setHeader("mcp-session-id", "corpus-mcp-session");
			response.end(
				JSON.stringify(
					result === undefined
						? { jsonrpc: "2.0", id: message.id, error: { code: -32601, message: "Method not found" } }
						: { jsonrpc: "2.0", id: message.id, result },
				),
			);
		});
	});
	server.listen(mcpPort, "127.0.0.1");
	return server;
}

// The client's `onMcpUpdate`: the server list and its tools, as the page renders them.
async function untilToolListed(socket: TestSocket): Promise<void> {
	await socket.until((text) => {
		if (!text.includes("cf_agent_mcp_servers")) return false;
		const { mcp } = JSON.parse(text) as {
			mcp: { servers: Record<string, { name: string; state: string; server_url: string }>; tools: { name: string }[] };
		};
		const servers = Object.values(mcp.servers);
		return (
			servers.some((entry) => entry.name === "corpus" && entry.server_url === mcpUrl && entry.state === "ready") &&
			mcp.tools.some((tool) => tool.name === "echo")
		);
	});
}

const scenario: Scenario = async (t) => {
	const mcp = startMcpServer();
	try {
		await t.step("the demo page is served from assets", "http", async () => {
			assert.match(await t.text("/"), /<div id="root"/);
		});

		await t.step("a page connects, adds an MCP server, and sees its tools over the WebSocket", "websocket", async () => {
			const socket = await t.webSocket(room);
			await socket.until((text) => text.includes("cf_agent_mcp_servers"));
			const added = await t.text(`${room}/add-mcp`, {
				method: "POST",
				body: JSON.stringify({ name: "corpus", url: mcpUrl }),
			});
			assert.equal(added, "Ok");
			await untilToolListed(socket);
			await socket.close();
		});

		await t.step("after the agent sleeps, a new page sees the same server and tools", "sleep", async () => {
			await t.waitForSleep();
			const socket = await t.webSocket(room);
			await untilToolListed(socket);
			await socket.close();
		});

		await t.step("after a restart, a new page sees the same server and tools", "restart", async () => {
			await t.restart();
			const socket = await t.webSocket(room);
			await untilToolListed(socket);
			await socket.close();
		});

		await t.step("another session has its own agent, with no servers", "do-state", async () => {
			const socket = await t.webSocket("/agents/my-agent/other-session");
			const first = JSON.parse(await socket.until((text) => text.includes("cf_agent_mcp_servers"))) as {
				mcp: { servers: Record<string, unknown> };
			};
			assert.deepEqual(first.mcp.servers, {});
			await socket.close();
		});
	} finally {
		mcp.close();
	}
};

export default scenario;
