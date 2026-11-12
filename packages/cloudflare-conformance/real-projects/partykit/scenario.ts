import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { join } from "node:path";

import type { Scenario, TestSocket } from "../../src/real-projects/scenario.js";

const scenario: Scenario = async (t) => {
	// The wire protocol of y-partyserver/provider, with the fixture's own Yjs packages.
	const load = createRequire(join(t.directory, "package.json"));
	const Y = load("yjs");
	const sync = load("y-protocols/sync");
	const encoding = load("lib0/encoding");
	const decoding = load("lib0/decoding");
	const messageSync = 0;
	const customPrefix = "__YPS:";

	interface Editor {
		text(): string;
		insert(value: string): void;
		custom: string[];
		failure(): Error | undefined;
		send(data: string): void;
		close(): Promise<void>;
	}

	const openEditor = async (room: string): Promise<Editor> => {
		const socket: TestSocket = await t.webSocket(`/parties/document/${room}`);
		const doc = new Y.Doc();
		const custom: string[] = [];
		let failure: Error | undefined;
		let closing = false;
		const send = (write: (encoder: unknown) => void) => {
			const encoder = encoding.createEncoder();
			encoding.writeVarUint(encoder, messageSync);
			write(encoder);
			socket.send(encoding.toUint8Array(encoder));
		};
		doc.on("update", (update: Uint8Array, origin: unknown) => {
			if (origin !== socket) send((encoder) => sync.writeUpdate(encoder, update));
		});
		void (async () => {
			for (;;) {
				const bytes = await socket.nextBytes(120_000);
				const asText = new TextDecoder().decode(bytes);
				if (asText.startsWith(customPrefix)) {
					custom.push(asText.slice(customPrefix.length));
					continue;
				}
				const decoder = decoding.createDecoder(bytes);
				if (decoding.readVarUint(decoder) !== messageSync) continue;
				const reply = encoding.createEncoder();
				encoding.writeVarUint(reply, messageSync);
				sync.readSyncMessage(decoder, reply, doc, socket);
				if (encoding.length(reply) > 1) socket.send(encoding.toUint8Array(reply));
			}
		})().catch((error: Error) => {
			if (!closing) failure = error;
		});
		send((encoder) => sync.writeSyncStep1(encoder, doc));
		return {
			text: () => doc.getText("default").toString() as string,
			insert: (value) => doc.getText("default").insert(doc.getText("default").length, value),
			custom,
			failure: () => failure,
			send: (data) => socket.send(data),
			close: async () => {
				closing = true;
				await socket.close();
			},
		};
	};

	const waitFor = async (what: string, ready: () => boolean, editors: Editor[]): Promise<void> => {
		const deadline = Date.now() + 15_000;
		while (!ready()) {
			for (const editor of editors) {
				const failure = editor.failure();
				if (failure !== undefined) throw failure;
			}
			if (Date.now() > deadline) throw new Error(`Timed out waiting for ${what}`);
			await t.delay(25);
		}
	};
	const seesText = (editor: Editor, text: string) =>
		waitFor(`the text ${JSON.stringify(text)}, got ${JSON.stringify(editor.text())}`, () => editor.text() === text, [editor]);

	await t.step("editors stay connected across the room's hibernation, and an edit wakes it", "sleep", async () => {
		// First step of the run, with one room: waitForSleep returns on any actor's sleep.
		const alice = await openEditor("hibernating-room");
		const bob = await openEditor("hibernating-room");
		alice.insert("before");
		await seesText(bob, "before");
		await t.waitForSleep();
		alice.insert(" after");
		await seesText(bob, "before after");
		await alice.close();
		await bob.close();
	});

	await t.step("two editors sync edits in both directions", "websocket", async () => {
		await t.waitForSleep();
		const alice = await openEditor("notes");
		const bob = await openEditor("notes");
		alice.insert("hello");
		await seesText(bob, "hello");
		bob.insert(" world");
		await seesText(alice, "hello world");
		await alice.close();
		await bob.close();
	});

	await t.step("a custom ping answers the sender and notifies the others", "websocket", async () => {
		const alice = await openEditor("notes");
		const bob = await openEditor("notes");
		await seesText(bob, "hello world");
		alice.send(`${customPrefix}${JSON.stringify({ action: "ping" })}`);
		await waitFor("the pong", () => alice.custom.some((text) => text.includes('"pong"')), [alice]);
		await waitFor("the notification", () => bob.custom.some((text) => text.includes("Someone pinged!")), [bob]);
		await alice.close();
		await bob.close();
	});

	await t.step("the document is saved when the room empties, and comes back after a sleep", "sleep", async () => {
		await t.waitForSleep();
		const carol = await openEditor("notes");
		await seesText(carol, "hello world");
		await carol.close();
	});

	await t.step("a room's document is separate from another room's", "do-state", async () => {
		const other = await openEditor("other-room");
		other.insert("private");
		await seesText(other, "private");
		const reader = await openEditor("notes");
		await seesText(reader, "hello world");
		assert.equal(reader.text(), "hello world");
		await other.close();
		await reader.close();
	});

	await t.step("the document survives an orange dev and engine restart", "restart", async () => {
		await t.restart();
		const dave = await openEditor("notes");
		await seesText(dave, "hello world");
		await dave.close();
	});
};

export default scenario;
