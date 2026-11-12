import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import { join } from "node:path";

import type { Scenario, TestSocket } from "../../src/real-projects/scenario.js";

const slug = "scenario-room";

interface SyncMessage {
	type: string;
	connectRequestId?: string;
	hydrationType?: string;
	diff?: Record<string, unknown>;
	action?: unknown;
	clientClock?: number;
	data?: SyncMessage[];
}

function events(text: string): SyncMessage[] {
	const message = JSON.parse(text) as SyncMessage;
	return message.type === "data" ? (message.data ?? []) : [message];
}

function pageRecord(id: string, name: string) {
	return { id, typeName: "page", name, index: "a5", meta: {} };
}

const scenario: Scenario = async (t) => {
	// The real client sends the schema of its tldraw version in the handshake.
	const require = createRequire(join(t.directory, "package.json"));
	const { createTLSchema, defaultShapeSchemas } = require("@tldraw/tlschema");
	const { getTlsyncProtocolVersion } = require("@tldraw/sync-core");
	const schema = createTLSchema({ shapes: { ...defaultShapeSchemas } }).serialize();

	const connect = async () => {
		const id = randomUUID();
		const socket = await t.webSocket(`/connect/${slug}?sessionId=${id}&storeId=${id}`);
		socket.send(
			JSON.stringify({
				type: "connect",
				connectRequestId: id,
				lastServerClock: -1,
				protocolVersion: getTlsyncProtocolVersion(),
				schema,
			}),
		);
		const hydrated = JSON.parse(await socket.until((text) => text.includes('"hydrationType"'))) as SyncMessage;
		assert.equal(hydrated.connectRequestId, id);
		return { socket, records: hydrated.diff ?? {} };
	};
	const pushAndCommit = async (socket: TestSocket, clientClock: number, diff: Record<string, unknown>) => {
		socket.send(JSON.stringify({ type: "push", clientClock, diff }));
		const text = await socket.until((message) =>
			events(message).some((event) => event.type === "push_result" && event.clientClock === clientClock),
		);
		const result = events(text).find((event) => event.type === "push_result" && event.clientClock === clientClock);
		assert.equal(result?.action, "commit");
	};

	await t.step("an uploaded asset is stored once in R2 and comes back", "binding", async () => {
		const bytes = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);
		const upload = { method: "POST", headers: { "content-type": "image/png" }, body: bytes };
		assert.deepEqual(await t.json("/uploads/scenario-asset", upload), { object: "asset-uploads/scenario-asset" });
		await t.json("/uploads/scenario-asset", upload, 409);
		const response = await t.fetch("/uploads/scenario-asset");
		assert.equal(response.status, 200);
		assert.deepEqual(new Uint8Array(await response.arrayBuffer()), bytes);
	});

	await t.step("a page pushed by one client reaches the other client in the room", "websocket", async () => {
		const alice = await connect();
		const bob = await connect();
		await pushAndCommit(alice.socket, 1, { "page:shared": ["put", pageRecord("page:shared", "Shared")] });
		const patch = await bob.socket.until((text) =>
			events(text).some((event) => event.type === "patch" && event.diff?.["page:shared"] !== undefined),
		);
		assert.match(patch, /"name":"Shared"/);
		await alice.socket.close();
		await bob.socket.close();
	});

	await t.step("a client that joins while the room is live gets the page in its hydration", "do-state", async () => {
		const holder = await connect();
		const carol = await connect();
		assert.ok(carol.records["page:shared"], "page:shared is in the hydration diff");
		await carol.socket.close();
		await holder.socket.close();
	});

	await t.step("a connected client keeps the room alive through an idle period, and its next push commits", "websocket", async () => {
		const dave = await connect();
		await t.delay(15_000);
		await pushAndCommit(dave.socket, 1, { "page:idle": ["put", pageRecord("page:idle", "Idle")] });
		await dave.socket.close();
	});

	await t.step("when everyone leaves the room saves to R2 and sleeps, and the page comes back from R2", "sleep", async () => {
		await t.waitForSleep(60_000);
		const erin = await connect();
		assert.ok(erin.records["page:shared"], "page:shared is in the hydration diff");
		assert.ok(erin.records["page:idle"], "page:idle is in the hydration diff");
		await erin.socket.close();
	});

	await t.step("a page pushed before an orange dev and engine restart is there after it", "restart", async () => {
		const frank = await connect();
		await pushAndCommit(frank.socket, 1, { "page:restart": ["put", pageRecord("page:restart", "Restart")] });
		// The project's persist alarm is throttled by 2 s, then fires.
		await t.delay(4_000);
		await frank.socket.close();
		await t.delay(1_000);
		await t.restart();
		const grace = await connect();
		assert.ok(grace.records["page:restart"], "page:restart is in the hydration diff");
		assert.ok(grace.records["page:shared"], "page:shared is in the hydration diff");
		await grace.socket.close();
	});
};

export default scenario;
