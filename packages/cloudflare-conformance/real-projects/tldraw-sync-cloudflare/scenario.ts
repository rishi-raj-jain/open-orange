import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { join } from "node:path";

import type { Scenario, ScenarioContext, TestSocket } from "../../src/real-projects/scenario.js";

const room = "scenario-room";

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

	let sessions = 0;
	const connect = async (context: ScenarioContext) => {
		sessions += 1;
		const socket = await context.webSocket(`/api/connect/${room}?sessionId=session-${sessions}&storeId=store-${sessions}`);
		const connectRequestId = `connect-${sessions}`;
		socket.send(
			JSON.stringify({
				type: "connect",
				connectRequestId,
				lastServerClock: -1,
				protocolVersion: getTlsyncProtocolVersion(),
				schema,
			}),
		);
		const hydrated = JSON.parse(await socket.until((text) => text.includes('"hydrationType"'))) as SyncMessage;
		assert.equal(hydrated.connectRequestId, connectRequestId);
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

	await t.step("serves the app page", "http", async () => {
		assert.match(await t.text("/"), /id="root"/);
	});

	await t.step("a page pushed by one client reaches the other client in the room", "websocket", async () => {
		const alice = await connect(t);
		const bob = await connect(t);
		await pushAndCommit(alice.socket, 1, { "page:shared": ["put", pageRecord("page:shared", "Shared")] });
		const patch = await bob.socket.until((text) =>
			events(text).some((event) => event.type === "patch" && event.diff?.["page:shared"] !== undefined),
		);
		assert.match(patch, /"name":"Shared"/);
		await alice.socket.close();
		await bob.socket.close();
	});

	await t.step("a later client hydrates the page from the room's SQLite storage", "do-state", async () => {
		const carol = await connect(t);
		assert.ok(carol.records["page:shared"], "page:shared is in the hydration diff");
		await carol.socket.close();
	});

	await t.step("the client's ping gets the auto-response pong", "websocket", async () => {
		const dave = await connect(t);
		dave.socket.send('{"type":"ping"}');
		assert.equal(await dave.socket.until((text) => text.includes('"pong"')), '{"type":"pong"}');
		await dave.socket.close();
	});

	await t.step("an uploaded asset is stored once in R2 and comes back", "binding", async () => {
		const bytes = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);
		const upload = { method: "POST", headers: { "content-type": "image/png" }, body: bytes };
		assert.deepEqual(await t.json("/api/uploads/scenario-asset", upload), { ok: true });
		await t.json("/api/uploads/scenario-asset", upload, 409);
		const response = await t.fetch("/api/uploads/scenario-asset");
		assert.equal(response.status, 200);
		assert.equal(response.headers.get("content-type"), "image/png");
		assert.deepEqual(new Uint8Array(await response.arrayBuffer()), bytes);
	});

	await t.step("the room sleeps when everyone left, and the page comes back", "sleep", async () => {
		await t.waitForSleep();
		const erin = await connect(t);
		assert.ok(erin.records["page:shared"], "page:shared is in the hydration diff");
		await erin.socket.close();
	});

	await t.step("the room hibernates while a connected client pings every 5 s", "sleep", async () => {
		const frank = await connect(t);
		// The real client pings every 5 s, and the auto-response is there so that this does not wake the room.
		const pings = setInterval(() => frank.socket.send('{"type":"ping"}'), 5_000);
		try {
			await t.waitForSleep();
		} finally {
			clearInterval(pings);
			await frank.socket.close();
		}
	});

	await t.step("a client stays connected while the room hibernates, and its next push commits", "sleep", async () => {
		await t.waitForSleep();
		const grace = await connect(t);
		await pushAndCommit(grace.socket, 1, { "page:grace": ["put", pageRecord("page:grace", "Grace")] });
		// The room stores the session snapshot for its resume on a debounce.
		await t.delay(6_000);
		await t.waitForSleep();
		await pushAndCommit(grace.socket, 2, { "page:grace2": ["put", pageRecord("page:grace2", "Grace 2")] });
		await grace.socket.close();
	});

	await t.step("the pages survive an orange dev and engine restart", "restart", async () => {
		await t.restart();
		const heidi = await connect(t);
		assert.ok(heidi.records["page:shared"], "page:shared is in the hydration diff");
		assert.ok(heidi.records["page:grace"], "page:grace is in the hydration diff");
		await heidi.socket.close();
	});
};

export default scenario;
