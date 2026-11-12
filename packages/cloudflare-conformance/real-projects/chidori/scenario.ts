import assert from "node:assert/strict";
import { createHash } from "node:crypto";

import type { Scenario } from "../../src/real-projects/scenario.js";

const jsonHeaders = { "content-type": "application/json" };
const manifest = new Uint8Array([0, 1, 2, 250, 251, 255]);
const etag = (bytes: Uint8Array) => `"${createHash("sha256").update(bytes).digest("hex")}"`;

const scenario: Scenario = async (t) => {
	const append = async (run: string, seq: number) => {
		await t.text(`/runs/${run}/records`, {
			method: "POST",
			headers: jsonHeaders,
			body: JSON.stringify({ seq, function: "fetch", result: `value-${seq}` }),
		});
	};
	const blob = async (run: string, key: string) =>
		new Uint8Array(await (await t.fetch(`/runs/${run}/blobs/${key}`)).arrayBuffer());

	await t.step("a run's journal keeps its order, and the run is listed in the index", "do-state", async () => {
		assert.equal((await t.fetch("/runs/run-a/records")).status, 404);
		for (const seq of [1, 2, 3]) await append("run-a", seq);
		// A re-sent record replaces the earlier one and keeps its place.
		await t.text("/runs/run-a/records", {
			method: "POST",
			headers: jsonHeaders,
			body: JSON.stringify({ seq: 2, function: "fetch", result: "replayed" }),
		});
		const records = await t.json<{ seq: number; result: string }[]>("/runs/run-a/records");
		assert.deepEqual(records.map((record) => record.seq), [1, 2, 3]);
		assert.equal(records[1]!.result, "replayed");
		assert.deepEqual(await t.json("/runs"), ["run-a"]);
	});

	await t.step("two runs do not see each other's journal, and a PUT replaces one journal", "do-state", async () => {
		await append("run-b", 10);
		await t.text("/runs/run-b/records", {
			method: "PUT",
			headers: jsonHeaders,
			body: JSON.stringify([{ seq: 7 }, { seq: 8 }]),
		});
		const b = await t.json<{ seq: number }[]>("/runs/run-b/records");
		assert.deepEqual(b.map((record) => record.seq), [7, 8]);
		const a = await t.json<{ seq: number }[]>("/runs/run-a/records");
		assert.deepEqual(a.map((record) => record.seq), [1, 2, 3]);
		assert.deepEqual(await t.json("/runs"), ["run-a", "run-b"]);
	});

	await t.step("blobs are bytes, and conditional writes act as a compare-and-swap", "do-state", async () => {
		const put = (body: Uint8Array, headers: Record<string, string>) =>
			t.fetch("/runs/run-a/blobs/manifest", { method: "PUT", headers, body });
		assert.equal((await put(manifest, { "if-none-match": "*" })).status, 200);
		assert.equal((await put(manifest, { "if-none-match": "*" })).status, 412);
		assert.deepEqual(await blob("run-a", "manifest"), manifest);
		const next = new Uint8Array([9, 9, 9]);
		assert.equal((await put(next, { "if-match": etag(next) })).status, 412);
		assert.equal((await put(next, { "if-match": etag(manifest) })).status, 200);
		assert.deepEqual(await blob("run-a", "manifest"), next);
		assert.deepEqual(await t.json("/runs/run-a/blobs"), ["manifest"]);
	});

	await t.step("of many writers racing for one lease, exactly one wins", "do-state", async () => {
		const writers = Array.from({ length: 8 }, (_, index) =>
			t.fetch("/runs/run-a/blobs/lease", {
				method: "PUT",
				headers: { "if-none-match": "*" },
				body: new Uint8Array([index]),
			}),
		);
		const statuses = (await Promise.all(writers)).map((response) => response.status).sort();
		assert.deepEqual(statuses, [200, 412, 412, 412, 412, 412, 412, 412]);
	});

	await t.step("the agent registry lives in the singleton index object", "do-state", async () => {
		await t.text("/registry/planner", {
			method: "PUT",
			headers: jsonHeaders,
			body: JSON.stringify({ name: "planner", runId: "run-a" }),
		});
		assert.deepEqual(await t.json("/registry/planner"), { name: "planner", runId: "run-a" });
		assert.deepEqual(await t.json("/registry"), [{ name: "planner", runId: "run-a" }]);
		assert.equal((await t.fetch("/registry/missing")).status, 404);
	});

	const everythingIsKept = async () => {
		const records = await t.json<{ seq: number }[]>("/runs/run-a/records");
		assert.deepEqual(records.map((record) => record.seq), [1, 2, 3]);
		assert.deepEqual(await blob("run-a", "manifest"), new Uint8Array([9, 9, 9]));
		assert.deepEqual(await t.json("/runs"), ["run-a", "run-b"]);
		assert.deepEqual(await t.json("/registry/planner"), { name: "planner", runId: "run-a" });
	};

	await t.step("the journal, blobs, index, and registry survive the objects' sleep", "sleep", async () => {
		await t.waitForSleep();
		await everythingIsKept();
	});

	await t.step("the journal, blobs, index, and registry survive a restart", "restart", async () => {
		await t.restart();
		await everythingIsKept();
	});
};

export default scenario;
