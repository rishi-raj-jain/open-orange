import assert from "node:assert/strict";
import { realpathSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";

import type { Scenario, TestSocket } from "../../src/real-projects/scenario.js";

const scenario: Scenario = async (t) => {
	// The client libraries that y-durableobjects itself depends on, in the same versions.
	const library = realpathSync(join(t.directory, "node_modules", "y-durableobjects", "package.json"));
	const load = createRequire(library);
	const Y = load("yjs") as any;
	const sync = load("y-protocols/sync") as any;
	const awareness = load("y-protocols/awareness") as any;
	const encoding = load("lib0/encoding") as any;
	const decoding = load("lib0/decoding") as any;
	const syncType = 0;
	const awarenessType = 1;

	// What y-websocket does: send step 1 on open, answer the server's messages, and send each local edit.
	class Client {
		readonly doc = new Y.Doc();
		readonly presence = new awareness.Awareness(this.doc);
		private constructor(private readonly socket: TestSocket) {
			this.doc.on("update", (update: Uint8Array, origin: unknown) => {
				if (origin === this) return;
				const encoder = encoding.createEncoder();
				encoding.writeVarUint(encoder, syncType);
				sync.writeUpdate(encoder, update);
				socket.send(encoding.toUint8Array(encoder));
			});
		}
		static async open(room: string): Promise<Client> {
			const client = new Client(await t.webSocket(`/editor/${room}`));
			const encoder = encoding.createEncoder();
			encoding.writeVarUint(encoder, syncType);
			sync.writeSyncStep1(encoder, client.doc);
			client.socket.send(encoding.toUint8Array(encoder));
			return client;
		}
		text(): string {
			return this.doc.getText("root").toString();
		}
		type(value: string): void {
			this.doc.getText("root").insert(this.text().length, value);
		}
		sendPresence(state: Record<string, unknown>): void {
			this.presence.setLocalState(state);
			const encoder = encoding.createEncoder();
			encoding.writeVarUint(encoder, awarenessType);
			encoding.writeVarUint8Array(encoder, awareness.encodeAwarenessUpdate(this.presence, [this.doc.clientID]));
			this.socket.send(encoding.toUint8Array(encoder));
		}
		// Handles messages until `done` holds, and fails with what was seen after the limit.
		async until(done: () => boolean, timeoutMs = 15_000): Promise<void> {
			const deadline = Date.now() + timeoutMs;
			while (!done()) {
				const remaining = deadline - Date.now();
				if (remaining <= 0) throw new Error(`Timed out with text ${JSON.stringify(this.text())}`);
				const message = await this.socket.nextBytes(remaining);
				const decoder = decoding.createDecoder(message);
				const type = decoding.readVarUint(decoder);
				if (type === syncType) {
					const encoder = encoding.createEncoder();
					encoding.writeVarUint(encoder, syncType);
					sync.readSyncMessage(decoder, encoder, this.doc, this);
					if (encoding.length(encoder) > 1) this.socket.send(encoding.toUint8Array(encoder));
				} else if (type === awarenessType) {
					awareness.applyAwarenessUpdate(this.presence, decoding.readVarUint8Array(decoder), this);
				}
			}
		}
		close(): Promise<void> {
			return this.socket.close();
		}
	}

	await t.step("a plain request gets the upgrade error", "http", async () => {
		assert.equal(await t.text("/editor/plain", {}, 426), "Expected websocket");
	});

	await t.step("two editors see each other's edits", "websocket", async () => {
		const alice = await Client.open("notes");
		const bob = await Client.open("notes");
		alice.type("hello");
		await bob.until(() => bob.text() === "hello");
		bob.type(" world");
		await alice.until(() => alice.text() === "hello world");
		await alice.close();
		await bob.close();
	});

	await t.step("a cursor sent through awareness reaches the other editor", "websocket", async () => {
		const alice = await Client.open("cursors");
		const bob = await Client.open("cursors");
		alice.sendPresence({ user: "alice", cursor: 3 });
		await bob.until(() => bob.presence.getStates().get(alice.doc.clientID)?.user === "alice");
		await alice.close();
		await bob.close();
	});

	await t.step("a document in another room stays apart", "websocket", async () => {
		const other = await Client.open("other-room");
		other.type("private");
		await other.until(() => other.text() === "private");
		const reader = await Client.open("notes");
		await reader.until(() => reader.text() === "hello world");
		assert.equal(reader.text().includes("private"), false);
		await other.close();
		await reader.close();
	});

	await t.step("the document comes back after the room sleeps with nobody in it", "sleep", async () => {
		await t.waitForSleep();
		const carol = await Client.open("notes");
		await carol.until(() => carol.text() === "hello world");
		await carol.close();
	});

	await t.step("two open editors keep syncing across a hibernation", "sleep", async () => {
		const dave = await Client.open("notes");
		const erin = await Client.open("notes");
		await dave.until(() => dave.text() === "hello world");
		await erin.until(() => erin.text() === "hello world");
		await t.waitForSleep();
		dave.type("!");
		await erin.until(() => erin.text() === "hello world!");
		await dave.close();
		await erin.close();
	});

	await t.step("the document survives an orange dev and engine restart", "restart", async () => {
		await t.restart();
		const frank = await Client.open("notes");
		await frank.until(() => frank.text().startsWith("hello world"));
		await frank.close();
	});
};

export default scenario;
