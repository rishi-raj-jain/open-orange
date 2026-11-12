import assert from "node:assert/strict";

import type { Scenario } from "../../src/real-projects/scenario.js";

const query = (body: unknown): RequestInit => ({
	method: "POST",
	headers: { "Content-Type": "application/json" },
	body: JSON.stringify(body),
});

const adminAuthorization = `Basic ${Buffer.from("admin:password").toString("base64")}`;

// The README's Worker names the object after the path, so the Studio reads this object by this name.
const objectName = "/query/raw";

const studioPost = (body: unknown): RequestInit => ({
	method: "POST",
	headers: { Authorization: adminAuthorization },
	body: JSON.stringify(body),
});

const scenario: Scenario = async (t) => {
	const assertRows = async (expected: unknown[][]) => {
		const { result } = await t.json<{ result: { columns: string[]; rows: unknown[][] }[] }>(
			objectName,
			query({ sql: "SELECT id, name FROM artists ORDER BY id" }),
		);
		assert.deepEqual(result[0]?.columns, ["id", "name"]);
		assert.deepEqual(result[0]?.rows, expected);
	};

	await t.step("/query/raw writes with bound parameters, and another request reads the rows", "do-state", async () => {
		await t.json(objectName, query({ sql: "CREATE TABLE artists (id INTEGER PRIMARY KEY, name TEXT)" }));
		await t.json(objectName, query({ sql: "INSERT INTO artists VALUES (?, ?)", params: [1, "Nina"] }));
		await assertRows([[1, "Nina"]]);
	});

	await t.step("/query/raw runs a transaction list, and returns one result for each statement", "do-state", async () => {
		const { result } = await t.json<{ result: { rows: unknown[][] }[] }>(
			objectName,
			query({
				transaction: [
					{ sql: "INSERT INTO artists VALUES (?, ?)", params: [2, "Miles"] },
					{ sql: "SELECT count(*) AS total FROM artists" },
				],
			}),
		);
		assert.equal(result.length, 2);
		assert.deepEqual(result[1]?.rows, [[2]]);
	});

	await t.step("other routes reach the class's own fetch, and a preflight gets the CORS headers", "do-state", async () => {
		assert.equal(await t.text("/anything"), "Hello from MyDurableObject");
		const preflight = await t.fetch(objectName, { method: "OPTIONS" });
		assert.equal(preflight.status, 204);
		assert.equal(preflight.headers.get("access-control-allow-origin"), "*");
	});

	await t.step("a failed statement returns a server error, and the rows stay", "do-state", async () => {
		const failed = await t.fetch(objectName, query({ sql: "SELECT * FROM no_such_table" }));
		await failed.text();
		assert.equal(failed.status, 500);
		await assertRows([
			[1, "Nina"],
			[2, "Miles"],
		]);
	});

	await t.step("Studio refuses wrong credentials, and serves its pages with the right ones", "http", async () => {
		assert.equal((await t.fetch("/studio")).status, 401);
		const wrong = await t.fetch("/studio", {
			headers: { Authorization: `Basic ${Buffer.from("admin:wrong").toString("base64")}` },
		});
		assert.equal(wrong.status, 401);
		assert.match(await t.text("/studio", { headers: { Authorization: adminAuthorization } }), /Outerbase Studio/);
		const page = await t.text(`/studio?id=${encodeURIComponent(objectName)}`, {
			headers: { Authorization: adminAuthorization },
		});
		assert.match(page, /id="editor"/);
	});

	await t.step("Studio reads and writes through __studio RPC, and a failing transaction rolls back", "do-state", async () => {
		const read = await t.json("/studio", studioPost({ type: "query", id: objectName, statement: "SELECT name FROM artists ORDER BY id" }));
		assert.deepEqual(read.result.rows, [{ name: "Nina" }, { name: "Miles" }]);
		assert.deepEqual(read.result.headers.map((header: { displayName: string }) => header.displayName), ["name"]);

		const written = await t.json("/studio", studioPost({
			type: "transaction",
			id: objectName,
			statements: ["INSERT INTO artists VALUES (3, 'Ella')", "SELECT count(*) AS total FROM artists"],
		}));
		assert.deepEqual(written.result[1].rows, [{ total: 3 }]);
		await assertRows([
			[1, "Nina"],
			[2, "Miles"],
			[3, "Ella"],
		]);

		const failed = await t.json("/studio", studioPost({
			type: "transaction",
			id: objectName,
			statements: ["INSERT INTO artists VALUES (4, 'Billie')", "SELECT * FROM no_such_table"],
		}));
		assert.match(failed.error, /no_such_table/);
		const { result } = await t.json("/studio", studioPost({ type: "query", id: objectName, statement: "SELECT count(*) AS total FROM artists" }));
		assert.deepEqual(result.rows, [{ total: 3 }]);
	});

	await t.step("the rows survive the object's sleep", "sleep", async () => {
		await t.waitForSleep();
		await assertRows([
			[1, "Nina"],
			[2, "Miles"],
			[3, "Ella"],
		]);
	});

	await t.step("the rows survive an orange dev and engine restart", "restart", async () => {
		await t.restart();
		await assertRows([
			[1, "Nina"],
			[2, "Miles"],
			[3, "Ella"],
		]);
	});
};

export default scenario;
