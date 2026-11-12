import assert from "node:assert/strict";

import type { Scenario } from "../../src/real-projects/scenario.js";

const MiB = 1024 * 1024;

// Each step is past a limit that workerd enforces locally. It fails there and passes on Orange.
const scenario: Scenario = async (t) => {
	const sized = async (path: string, field: string, expected: number) => {
		const body = await t.json(path);
		assert.equal(body.error, undefined);
		assert.equal(body[field], expected);
	};

	await t.step("SQLite: a 5 MiB BLOB", "do-state", async () => {
		await sized(`/blob?bytes=${5 * MiB}`, "size", 5 * MiB);
	});
	await t.step("SQLite: a 300 KB statement", "do-state", async () => {
		await sized("/long-statement?items=50000", "n", 50_000);
	});
	await t.step("SQLite: 200 bound parameters", "do-state", async () => {
		await sized("/params?count=200", "columns", 200);
	});
	await t.step("SQLite: a table with 200 columns", "do-state", async () => {
		await sized("/columns?count=200", "columns", 200);
	});
	await t.step("KV storage API: a 1.5 MiB value", "do-state", async () => {
		await sized(`/kv?bytes=${Math.floor(1.5 * MiB)}`, "size", Math.floor(1.5 * MiB));
	});
	await t.step("node:child_process runs a host command", "http", async () => {
		assert.deepEqual(await t.json("/node/child-process"), { stdout: "hi" });
	});
	await t.step("node:fs writes and reads a real file", "http", async () => {
		assert.deepEqual(await t.json("/node/fs"), { text: "on disk" });
	});
	await t.step("node:net listens on a port", "http", async () => {
		const { port } = await t.json("/node/net-server");
		assert.ok(port > 0);
	});
};

export default scenario;
