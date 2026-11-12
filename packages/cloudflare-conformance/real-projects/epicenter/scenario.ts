import assert from "node:assert/strict";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import type { Scenario, TestSocket } from "../../src/real-projects/scenario.js";

// The project's own wire codec. Its client needs browser or Durable Object storage, its frames do not.
interface Frame {
	kind: string;
	submission?: number;
	seq?: number;
	bytes?: Uint8Array;
}
interface Frames {
	encodeFrame(frame: { kind: "push"; submission: number; chunk: number; chunks: number; bytes: Uint8Array }): Uint8Array;
	decodeFrame(bytes: Uint8Array): { data: Frame | null; error: unknown };
}

interface Stat {
	head: number;
	entries: number;
	sockets: number;
	incarnation: string;
}

const scenario: Scenario = async (t) => {
	const framesPath = join(t.directory, "../../packages/app/src/data/sync/frames.ts");
	const { encodeFrame, decodeFrame } = (await import(pathToFileURL(framesPath).href)) as Frames;
	const stat = () => t.json<Stat>("/stat?app=lab");
	const bytesOf = (text: string) => new TextEncoder().encode(text);
	const textOf = (bytes: Uint8Array | undefined) => new TextDecoder().decode(bytes);
	const next = async (socket: TestSocket, kind: string): Promise<Frame> => {
		const deadline = Date.now() + 20_000;
		for (;;) {
			const { data, error } = decodeFrame(await socket.nextBytes(Math.max(1, deadline - Date.now())));
			if (error !== null || data === null) throw new Error(`Undecodable frame: ${JSON.stringify(error)}`);
			if (data.kind === kind) return data;
		}
	};
	const dial = async (cursor = 0): Promise<TestSocket> => {
		const socket = await t.webSocket(`/sync?app=lab&cursor=${cursor}&document=notes`);
		await next(socket, "admitted");
		return socket;
	};
	let submission = 0;
	const push = (socket: TestSocket, text: string): number => {
		submission += 1;
		socket.send(encodeFrame({ kind: "push", submission, chunk: 0, chunks: 1, bytes: bytesOf(text) }));
		return submission;
	};

	await t.step("the page is served, and a new authority reports an empty log over RPC", "http", async () => {
		assert.match(await t.text("/"), /<script/);
		const empty = await stat();
		assert.equal(empty.head, 0);
		assert.equal(empty.entries, 0);
	});

	await t.step("one device's push is acknowledged and relayed to the other device", "websocket", async () => {
		const alice = await dial();
		const bob = await dial();
		const sent = push(alice, "row-1");
		const ack = await next(alice, "ack");
		assert.deepEqual([ack.submission, ack.seq], [sent, 1]);
		const entry = await next(bob, "entry");
		assert.deepEqual([entry.seq, textOf(entry.bytes)], [1, "row-1"]);
		const { head, entries, sockets } = await stat();
		assert.deepEqual({ head, entries, sockets }, { head: 1, entries: 1, sockets: 2 });
		await alice.close();
		await bob.close();
	});

	await t.step("a late device catches up from the log, from the cursor it declares", "do-state", async () => {
		const writer = await dial(1);
		push(writer, "row-2");
		await next(writer, "ack");
		await writer.close();
		const fromStart = await dial(0);
		assert.equal(textOf((await next(fromStart, "entry")).bytes), "row-1");
		assert.equal(textOf((await next(fromStart, "entry")).bytes), "row-2");
		await fromStart.close();
		const fromOne = await dial(1);
		const entry = await next(fromOne, "entry");
		assert.deepEqual([entry.seq, textOf(entry.bytes)], [2, "row-2"]);
		await fromOne.close();
	});

	let beforeSleep = "";
	await t.step("two sockets stay open while the authority hibernates, and a push wakes it", "sleep", async () => {
		const alice = await dial(2);
		const bob = await dial(2);
		beforeSleep = (await stat()).incarnation;
		await t.waitForSleep(60_000);
		push(alice, "row-3");
		assert.equal((await next(alice, "ack")).seq, 3);
		assert.equal(textOf((await next(bob, "entry")).bytes), "row-3");
		await alice.close();
		await bob.close();
	});

	await t.step("after the authority sleeps, it is a new instance with the same log", "sleep", async () => {
		beforeSleep ||= (await stat()).incarnation;
		await t.waitForSleep(60_000);
		const woken = await stat();
		assert.notEqual(woken.incarnation, beforeSleep);
		assert.ok(woken.head >= 2, `head ${woken.head}`);
		const late = await dial(0);
		assert.equal(textOf((await next(late, "entry")).bytes), "row-1");
		await late.close();
	});

	await t.step("the log survives an orange dev and engine restart, and accepts new pushes", "restart", async () => {
		const { head } = await stat();
		await t.restart();
		assert.equal((await stat()).head, head);
		const late = await dial(0);
		assert.equal(textOf((await next(late, "entry")).bytes), "row-1");
		push(late, "row-after-restart");
		assert.equal((await next(late, "ack")).seq, head + 1);
		await late.close();
	});
};

export default scenario;
