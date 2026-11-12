import assert from "node:assert/strict";

import type { Scenario, ScenarioContext } from "../../src/real-projects/scenario.js";

// Every step states what workerd does. A step that fails on Orange and passes on workerd is a difference.
const scenario: Scenario = async (t) => {
	const sql = async (query: string, params: unknown[] = [], database = "main") =>
		await run(t, `/do/${database}`, query, params);
	const d1 = async (query: string, params: unknown[] = []) => await run(t, "/d1", query, params);
	const prove = (name: string, body: () => Promise<void>) => t.step(name, "do-state", body);

	await prove("sqlite_version() runs", async () => {
		const { rows } = await sql("SELECT sqlite_version() AS v");
		assert.match(rows[0].v, /^3\./);
	});

	// Compile-time math functions.
	await prove("math: cos() runs", async () => {
		assert.equal((await sql("SELECT cos(0) AS v")).rows[0].v, 1);
	});
	await prove("math: sqrt() and pow() run", async () => {
		assert.deepEqual((await sql("SELECT sqrt(16) AS a, pow(2, 3) AS b")).rows[0], { a: 4, b: 8 });
	});
	await prove("math: floor() and ceil() run", async () => {
		assert.deepEqual((await sql("SELECT floor(1.5) AS a, ceil(1.5) AS b")).rows[0], { a: 1, b: 2 });
	});
	await prove("math: abs() and round() run (core SQLite)", async () => {
		assert.deepEqual((await sql("SELECT abs(-2) AS a, round(1.5) AS b")).rows[0], { a: 2, b: 2 });
	});

	// DELETE and UPDATE with LIMIT, and their portable form.
	await sql("CREATE TABLE IF NOT EXISTS items (id INTEGER PRIMARY KEY, name TEXT)");
	await sql("INSERT INTO items (name) VALUES ('a'), ('b'), ('c'), ('d'), ('e'), ('f')");
	await prove("DELETE ... LIMIT runs", async () => {
		assert.equal((await sql("DELETE FROM items WHERE name = 'a' LIMIT 1")).rowsWritten, 1);
	});
	await prove("UPDATE ... LIMIT runs", async () => {
		assert.equal((await sql("UPDATE items SET name = 'z' WHERE name = 'b' LIMIT 1")).rowsWritten, 1);
	});
	await prove("workaround: DELETE WHERE rowid IN (SELECT ... LIMIT n) deletes n rows", async () => {
		const result = await sql(
			"DELETE FROM items WHERE rowid IN (SELECT rowid FROM items WHERE name IN ('c', 'd') ORDER BY id LIMIT 1)",
		);
		assert.equal(result.rowsWritten, 1);
	});

	// Cursor counters.
	await prove("counters: rowsRead counts scanned rows, not returned rows", async () => {
		await sql("CREATE TABLE IF NOT EXISTS scan (id INTEGER PRIMARY KEY, v INTEGER)");
		await sql("INSERT INTO scan (v) VALUES (1), (2), (3), (4), (5)");
		const { rows, rowsRead } = await sql("SELECT v FROM scan WHERE v = 3");
		assert.equal(rows.length, 1);
		assert.equal(rowsRead, 5);
	});
	await prove("counters: rowsWritten counts index writes", async () => {
		await sql("CREATE TABLE IF NOT EXISTS indexed (id INTEGER PRIMARY KEY, v INTEGER)");
		await sql("CREATE INDEX IF NOT EXISTS indexed_v ON indexed (v)");
		assert.equal((await sql("INSERT INTO indexed (v) VALUES (1)")).rowsWritten, 2);
	});
	await prove("counters: rowsWritten counts a plain insert", async () => {
		await sql("CREATE TABLE IF NOT EXISTS plain (v INTEGER)");
		assert.equal((await sql("INSERT INTO plain VALUES (1), (2)")).rowsWritten, 2);
	});

	// Authorizer.
	await prove("authorizer: PRAGMA journal_mode = DELETE is rejected", async () => {
		await assertRejected(sql("PRAGMA journal_mode = DELETE"), /not authorized/);
	});
	await prove("authorizer: ATTACH is rejected", async () => {
		await assertRejected(sql("ATTACH DATABASE ':memory:' AS other"), /not authorized/);
	});
	await prove("authorizer: sqlite_compileoption_used() is rejected", async () => {
		await assertRejected(sql("SELECT sqlite_compileoption_used('ENABLE_FTS5')"), /not authorized/);
	});
	await prove("authorizer: blocked function in a DEFAULT expression is rejected", async () => {
		await assertRejected(sql("CREATE TABLE bad (a TEXT DEFAULT (sqlite_compileoption_get(0)))"), /not authorized/);
	});
	await prove("reserved names: reading _cf_KV is rejected", async () => {
		await assertRejected(sql("SELECT * FROM _cf_KV"), /not authorized|prohibited/);
	});
	await prove("reserved names: the _cf_KV error names the column", async () => {
		await assertRejected(sql("SELECT key FROM _cf_KV"), /access to _cf_KV\.key is prohibited/);
	});
	await prove("reserved names: sqlite_master lists no _rivet_ table", async () => {
		const { rows } = await sql("SELECT name FROM sqlite_master WHERE name LIKE '\\_rivet\\_%' ESCAPE '\\'");
		assert.deepEqual(rows, []);
	});
	await prove("dump: every table sqlite_master lists can be read", async () => {
		const { rows } = await sql("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE '\\_cf\\_%' ESCAPE '\\' AND name NOT LIKE 'sqlite\\_%' ESCAPE '\\'");
		for (const { name } of rows) await sql(`SELECT count(*) FROM "${name}"`);
	});

	// Statements.
	await prove("multi-statement: bindings apply to the last statement", async () => {
		await sql("CREATE TABLE IF NOT EXISTS multi (v INTEGER)");
		const { rows } = await sql("INSERT INTO multi VALUES (1); SELECT ? AS v", [7]);
		assert.deepEqual(rows, [{ v: 7 }]);
	});
	await prove("multi-statement: only the last statement's rows return", async () => {
		const { rows } = await sql("SELECT 1 AS a; SELECT 2 AS b");
		assert.deepEqual(rows, [{ b: 2 }]);
	});
	await prove("empty result keeps columnNames", async () => {
		const { columnNames } = await sql("SELECT v FROM plain WHERE v = 99");
		assert.deepEqual(columnNames, ["v"]);
	});
	await prove("BEGIN in SQL is rejected, as on Cloudflare", async () => {
		await assertRejected(sql("BEGIN"), /state\.storage\.transaction|transaction/i);
	});

	// Features most apps reach for.
	await prove("JSON: json_extract and ->> run", async () => {
		const { rows } = await sql(`SELECT json_extract('{"a":1}', '$.a') AS a, '{"b":2}' ->> '$.b' AS b`);
		assert.deepEqual(rows[0], { a: 1, b: 2 });
	});
	await prove("JSON: json_each runs", async () => {
		const { rows } = await sql("SELECT value FROM json_each('[1,2]')");
		assert.deepEqual(rows, [{ value: 1 }, { value: 2 }]);
	});
	await prove("FTS5: a full-text table can be created and searched", async () => {
		await sql("CREATE VIRTUAL TABLE IF NOT EXISTS docs USING fts5(body)");
		await sql("INSERT INTO docs (body) VALUES ('durable objects on rivet')");
		assert.equal((await sql("SELECT body FROM docs WHERE docs MATCH 'rivet'")).rows.length, 1);
	});
	await prove("RETURNING and UPSERT run", async () => {
		await sql("CREATE TABLE IF NOT EXISTS kv (k TEXT PRIMARY KEY, v INTEGER)");
		await sql("INSERT INTO kv VALUES ('a', 1)");
		const { rows } = await sql("INSERT INTO kv VALUES ('a', 2) ON CONFLICT (k) DO UPDATE SET v = excluded.v RETURNING v");
		assert.deepEqual(rows, [{ v: 2 }]);
	});
	await prove("window functions, CTEs, STRICT, and generated columns run", async () => {
		await sql("CREATE TABLE IF NOT EXISTS modern (a INTEGER, b INTEGER GENERATED ALWAYS AS (a * 2) VIRTUAL) STRICT");
		await sql("INSERT INTO modern (a) VALUES (1), (2)");
		const { rows } = await sql("WITH x AS (SELECT b, row_number() OVER (ORDER BY a) AS n FROM modern) SELECT * FROM x");
		assert.deepEqual(rows, [{ b: 2, n: 1 }, { b: 4, n: 2 }]);
	});
	await prove("foreign keys are enforced by default", async () => {
		await sql("CREATE TABLE IF NOT EXISTS parent (id INTEGER PRIMARY KEY)");
		await sql("CREATE TABLE IF NOT EXISTS child (parent INTEGER REFERENCES parent (id))");
		await assertRejected(sql("INSERT INTO child VALUES (99)"), /FOREIGN KEY/);
	});

	// D1 uses the same SQLite build.
	const d1Prove = (name: string, body: () => Promise<void>) => t.step(name, "binding", body);
	await d1Prove("D1: cos() runs", async () => {
		assert.equal((await d1("SELECT cos(0) AS v")).results[0].v, 1);
	});
	await d1Prove("D1: DELETE ... LIMIT runs", async () => {
		await d1("CREATE TABLE IF NOT EXISTS t (v INTEGER)");
		await d1("INSERT INTO t VALUES (1), (2)");
		assert.equal((await d1("DELETE FROM t WHERE v > 0 LIMIT 1")).meta.changes, 1);
	});
	await d1Prove("D1: batch() runs statements in order", async () => {
		const response = await t.json("/d1/batch", {
			method: "POST",
			body: JSON.stringify(["CREATE TABLE IF NOT EXISTS b (v INTEGER)", "INSERT INTO b VALUES (1)", "SELECT v FROM b"]),
		});
		assert.deepEqual(response.at(-1).results, [{ v: 1 }]);
	});
	await d1Prove("D1: meta.rows_read counts scanned rows", async () => {
		await d1("CREATE TABLE IF NOT EXISTS r (v INTEGER)");
		await d1("INSERT INTO r VALUES (1), (2), (3)");
		assert.equal((await d1("SELECT v FROM r WHERE v = 2")).meta.rows_read, 3);
	});

	// Durability.
	await sql("CREATE TABLE IF NOT EXISTS durable (v TEXT)", [], "durable");
	await sql("INSERT INTO durable VALUES ('kept')", [], "durable");
	await t.step("rows survive the object's sleep", "sleep", async () => {
		await t.waitForSleep();
		assert.deepEqual((await sql("SELECT v FROM durable", [], "durable")).rows, [{ v: "kept" }]);
	});
	await t.step("rows survive a restart", "restart", async () => {
		await t.restart();
		assert.deepEqual((await sql("SELECT v FROM durable", [], "durable")).rows, [{ v: "kept" }]);
	});
};

async function run(t: ScenarioContext, path: string, sql: string, params: unknown[]): Promise<any> {
	const response = await t.fetch(path, { method: "POST", body: JSON.stringify({ sql, params }) });
	const body = (await response.json()) as { error?: string };
	if (body.error !== undefined) throw new Error(body.error);
	return body;
}

async function assertRejected(query: Promise<unknown>, pattern: RegExp): Promise<void> {
	await assert.rejects(query, pattern);
}

export default scenario;
