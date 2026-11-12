// @ts-nocheck
// Runs on Cloudflare inside the Worker that `orange migrate prepare` generates. It does two jobs for a
// D1 database that `orange migrate d1` moves to Orange:
//
// 1. `/__migrate-d1/<BINDING>/<op>` routes, behind WORKER_MIGRATOR_TOKEN: the schema, the write
//    freeze, a digest of the rows to check Orange's copy against, and the switch to Orange.
// 2. A wrapper around each D1 binding, so that once the database has moved, the app's queries run on
//    Orange instead.
//
// The freeze lives in the database itself: a state row and one trigger per table and write kind,
// all named `_orange_d1_*`. So it holds for every writer, not only this Worker. The freeze has a
// lease: if `orange migrate d1` stops without opening it again, writes resume once it runs out, and
// the switch then refuses.
// No imports: the Worker bundles this file with the app.

const routePrefix = "/__migrate-d1/";
const stateTable = "_orange_d1_state";
const triggerPrefix = "_orange_d1_";
const frozenMessage = "orange-d1-frozen";
// How long a Worker isolate trusts "this database is not migrating" before it checks again. The
// freeze triggers refuse writes regardless, so this only bounds how long a read can miss the move.
const noMigrationTtlMs = 1_000;

export const d1FrozenMessage = frozenMessage;

function quote(name) {
	return `"${String(name).replaceAll('"', '""')}"`;
}

function literal(text) {
	return `'${String(text).replaceAll("'", "''")}'`;
}

// --- Schema -----------------------------------------------------------------------------------------

const userObjects = `name NOT LIKE 'sqlite\\_%' ESCAPE '\\' AND name NOT LIKE '\\_cf\\_%' ESCAPE '\\' AND name NOT LIKE '\\_orange\\_d1\\_%' ESCAPE '\\'`;

async function sha256(text) {
	const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
	return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

// The user objects and the tables to check. A virtual table's shadow tables belong to it.
async function readSchema(db) {
	const [objects, list] = await db.batch([
		db.prepare(`SELECT type, name, tbl_name AS tableName, sql FROM sqlite_schema WHERE ${userObjects} AND sql IS NOT NULL ORDER BY type, name`),
		db.prepare("SELECT name, type, wr FROM pragma_table_list WHERE schema = 'main'"),
	]);
	const kinds = new Map(list.results.map((row) => [row.name, row]));
	const rows = objects.results.filter((row) => kinds.get(row.name)?.type !== "shadow");
	const tableRows = rows.filter((row) => row.type === "table");
	const details = tableRows.length === 0 ? [] : await db.batch(tableRows.map((table) => db.prepare("SELECT name, pk, hidden FROM pragma_table_xinfo(?) ORDER BY cid").bind(table.name)));
	const tables = tableRows.map((table, index) => ({
		// Generated columns are computed from the others, so the digest leaves them out.
		columns: details[index].results.filter((column) => column.hidden === 0).map((column) => ({ name: column.name, pk: column.pk })),
		name: table.name,
		virtual: kinds.get(table.name)?.type === "virtual",
		withoutRowid: kinds.get(table.name)?.wr === 1,
	}));
	if (kinds.has("sqlite_sequence")) {
		tables.push({ columns: [{ name: "name", pk: 0 }, { name: "seq", pk: 0 }], name: "sqlite_sequence", virtual: false, withoutRowid: false });
	}
	return {
		bytes: objects.meta.size_after ?? 0,
		hash: await sha256(rows.map((row) => `${row.type}\u0000${row.name}\u0000${row.tableName}\u0000${row.sql}`).join("\u0001")),
		objects: rows,
		tables,
	};
}

// --- The freeze ---------------------------------------------------------------------------------------

// Writes stop while the state is `frozen` and its lease runs, and for good once it is `moved`.
const blocked = `(SELECT state = 'moved' OR (state = 'frozen' AND until > unixepoch()) FROM ${stateTable})`;

// Every object of the database but SQLite's and D1's own, as one text: the app's schema, and the
// freeze's triggers and state table. The freeze stores it, and the switch compares it again, so a
// table created during the move (it has no triggers), or dropped and created again (that drops its
// triggers), stops the switch even when the app's schema reads the same.
const schemaText = `(SELECT json_group_array(json_array(type, name, tbl_name, sql) ORDER BY type, name) FROM sqlite_schema WHERE name NOT LIKE 'sqlite\\_%' ESCAPE '\\' AND name NOT LIKE '\\_cf\\_%' ESCAPE '\\')`;

// A statement that fails when `condition` holds, so its batch rolls back whole. D1 has no RAISE
// outside a trigger, so it breaks the state table's CHECK.
function abortIf(db, condition, ...params) {
	return db.prepare(`INSERT INTO ${stateTable} (id, state) SELECT 0, 'refused' WHERE ${condition}`).bind(...params);
}

function isAbort(error) {
	return String(error?.message ?? error).includes("CHECK constraint failed");
}

async function readState(db) {
	try {
		const row = await db.prepare(`SELECT state, until, url, freeze, unixepoch() AS now FROM ${stateTable}`).first();
		if (row === null) return { state: "none", url: null };
		// A lease that ran out lets writes through again, so the freeze no longer holds.
		if (row.state === "frozen" && row.until <= row.now) return { ...row, state: "expired" };
		return row;
	} catch (error) {
		if (isMissingStateTable(error)) return { state: "none", url: null };
		throw error;
	}
}

async function dropFreezeTriggers(db) {
	const { results } = await db.prepare(`SELECT name FROM sqlite_schema WHERE type = 'trigger' AND name LIKE '\\_orange\\_d1\\_%' ESCAPE '\\'`).all();
	return results.map(({ name }) => db.prepare(`DROP TRIGGER IF EXISTS ${quote(name)}`));
}

function leaseOf(body) {
	const seconds = Number(body.leaseSeconds);
	if (!Number.isInteger(seconds) || seconds < 1) throw new RouteError(400, "migrate_d1.bad_request", "leaseSeconds must be a positive integer");
	return seconds;
}

// The schema of a database that can freeze. Nothing changes if it can't.
async function freezableSchema(db, binding) {
	const state = await readState(db);
	if (state.state === "moved") throw new RouteError(409, "migrate_d1.moved", `${binding} has already moved to ${state.url}`);
	if (state.state === "frozen") {
		throw new RouteError(
			409,
			"migrate_d1.busy",
			`Another \`orange migrate d1\` is moving ${binding}, and holds its write freeze until ${new Date(state.until * 1000).toISOString()}. Wait for it to end. If it was killed, its freeze opens by itself then.`,
		);
	}
	const schema = await readSchema(db);
	const virtual = schema.tables.filter((table) => table.virtual).map((table) => table.name);
	if (virtual.length > 0) {
		throw new RouteError(
			422,
			"migrate_d1.virtual_tables",
			`D1's export can't include virtual tables: ${virtual.join(", ")}. Drop them on Cloudflare, move the database, and create them again on Orange.`,
		);
	}
	return schema;
}

// One batch, so the freeze applies whole or not at all. Writes committed before it are in the export,
// and writes after it fail. It refuses while another run's freeze holds, and when a table appeared or
// went since the schema read, so every table it freezes gets its triggers.
async function freeze(db, binding, body) {
	const lease = leaseOf(body);
	const schema = await freezableSchema(db, binding);
	const tables = schema.tables.filter((candidate) => candidate.name !== "sqlite_sequence").map((table) => table.name);
	const id = crypto.randomUUID();
	const message = literal(`${frozenMessage}: ${binding} is moving to Orange, so it takes no writes until the move ends`);
	const statements = [
		...(await dropFreezeTriggers(db)),
		db.prepare(`CREATE TABLE IF NOT EXISTS ${stateTable} (id INTEGER PRIMARY KEY CHECK (id = 1), state TEXT NOT NULL, until INTEGER, url TEXT, freeze TEXT, schema TEXT)`),
		abortIf(db, `EXISTS (SELECT 1 FROM ${stateTable} WHERE id = 1 AND (state = 'moved' OR (state = 'frozen' AND until > unixepoch())))`),
		abortIf(db, `(SELECT json_group_array(name ORDER BY name) FROM sqlite_schema WHERE type = 'table' AND ${userObjects}) != ?`, JSON.stringify(tables)),
		db.prepare(`INSERT OR REPLACE INTO ${stateTable} (id, state, until, url, freeze, schema) VALUES (1, 'frozen', unixepoch() + ?, NULL, ?, NULL)`).bind(lease, id),
	];
	for (const table of tables) {
		for (const kind of ["insert", "update", "delete"]) {
			const name = quote(`${triggerPrefix}${table}_${kind}`);
			statements.push(db.prepare(`CREATE TRIGGER ${name} BEFORE ${kind.toUpperCase()} ON ${quote(table)} WHEN ${blocked} BEGIN SELECT RAISE(ABORT, ${message}); END`));
		}
	}
	statements.push(db.prepare(`UPDATE ${stateTable} SET schema = ${schemaText} WHERE id = 1`));
	try {
		await db.batch(statements);
	} catch (error) {
		if (!isAbort(error)) throw error;
		// Throws when another run froze or moved the database meanwhile.
		await freezableSchema(db, binding);
		throw new RouteError(409, "migrate_d1.schema_changed", `${binding}'s tables changed while the freeze started. Nothing changed. Run the command again.`);
	}
	const row = await db.prepare(`SELECT until FROM ${stateTable}`).first();
	// The tables to check: the ones that this freeze covers, and `sqlite_sequence`.
	return { freeze: id, hash: schema.hash, tables: schema.tables.map((table) => table.name), until: row.until };
}

// Extends a lease that still runs. A lease that ran out can't come back: writes may have landed.
async function extend(db, body) {
	const lease = leaseOf(body);
	const result = await db
		.prepare(`UPDATE ${stateTable} SET until = max(until, unixepoch() + ?) WHERE id = 1 AND state = 'frozen' AND freeze = ? AND until > unixepoch()`)
		.bind(lease, String(body.freeze ?? ""))
		.run();
	if (result.meta.changes !== 1) throw new RouteError(409, "migrate_d1.freeze_lost", "the write freeze ran out or was replaced, so writes may have reached Cloudflare");
	return readState(db);
}

// Opens a freeze that this run made, and removes everything the freeze added. One batch, so it
// never opens another run's freeze, and never a move.
async function unfreeze(db, body) {
	try {
		await db.batch([
			abortIf(db, `NOT EXISTS (SELECT 1 FROM ${stateTable} WHERE id = 1 AND state = 'frozen' AND freeze = ?)`, String(body.freeze ?? "")),
			...(await dropFreezeTriggers(db)),
			db.prepare(`DROP TABLE ${stateTable}`),
		]);
	} catch (error) {
		if (!isAbort(error) && !isMissingStateTable(error)) throw error;
		return { unfrozen: false, state: (await readState(db)).state };
	}
	return { unfrozen: true, state: "none" };
}

// The switch. It holds only if the lease never ran out, so no write reached Cloudflare after the
// export, and every object is as the freeze left it, so no table took writes without its triggers.
// A repeat of a switch that happened answers the same, so a lost answer can be asked again.
async function moved(db, binding, body) {
	const url = String(body.url ?? "");
	if (!/^https?:\/\//.test(url)) throw new RouteError(400, "migrate_d1.bad_request", "moved needs the Orange Worker's url");
	const freeze = String(body.freeze ?? "");
	const result = await db
		.prepare(
			`UPDATE ${stateTable} SET state = 'moved', url = ?1 WHERE id = 1 AND freeze = ?2 AND ((state = 'frozen' AND until > unixepoch() AND schema = ${schemaText}) OR (state = 'moved' AND url = ?1))`,
		)
		.bind(url, freeze)
		.run();
	if (result.meta.changes === 1) return readState(db);
	const state = await readState(db);
	if (state.state === "frozen" && state.freeze === freeze) {
		throw new RouteError(
			409,
			"migrate_d1.schema_changed",
			`${binding}'s schema changed on Cloudflare after the freeze: a table was created, dropped, or changed, or a freeze trigger is gone. Writes may have reached Cloudflare, so the switch refuses.`,
		);
	}
	throw new RouteError(409, "migrate_d1.freeze_lost", "the write freeze ran out or was replaced, so writes may have reached Cloudflare");
}

// --- The digest -------------------------------------------------------------------------------------
//
// A page of rows in key order, as one SHA-256. Orange computes the same over its copy, so a wrong
// value fails the check, not only a wrong count. Each value is read in a form that stays exact
// through the D1 binding: INTEGER as decimal text, REAL as `printf('%!.17g')`, TEXT and BLOB as hex.
// A row is `<type><value>` per column, joined by `,`; rows are joined by `\n`. A REAL becomes the
// hex of its 8 bytes, because SQLite builds print some doubles with different digits. The implicit
// rowid of a table without INTEGER PRIMARY KEY is not data: D1's export renumbers it.

// The column that reads a rowid table's rowid, avoiding a user column with the same name.
function rowidName(table) {
	const names = new Set(table.columns.map((column) => column.name.toLowerCase()));
	const free = ["rowid", "_rowid_", "oid"].find((name) => !names.has(name));
	if (free === undefined) throw new RouteError(422, "migrate_d1.no_rowid", `table ${table.name} names columns rowid, _rowid_, and oid, so its rows can't be paged`);
	return free;
}

function keyColumns(table) {
	if (!table.withoutRowid) return [rowidName(table)];
	return table.columns
		.filter((column) => column.pk > 0)
		.sort((left, right) => left.pk - right.pk)
		.map((column) => quote(column.name));
}

function exact(column) {
	return `CASE typeof(${column}) WHEN 'integer' THEN CAST(${column} AS TEXT) WHEN 'real' THEN printf('%!.17g', ${column}) WHEN 'text' THEN hex(${column}) WHEN 'blob' THEN hex(${column}) END`;
}

// A key value as a tagged text that survives JSON: `i`, `r`, `t` (hex), or `b` (hex).
function tag(column) {
	return `CASE typeof(${column}) WHEN 'integer' THEN 'i' || ${column} WHEN 'real' THEN 'r' || printf('%!.17g', ${column}) WHEN 'text' THEN 't' || hex(${column}) WHEN 'blob' THEN 'b' || hex(${column}) END`;
}

function untagLiteral(tagged) {
	if (tagged === null) return "NULL";
	const body = String(tagged).slice(1);
	switch (String(tagged)[0]) {
		case "i":
			if (/^-?\d+$/.test(body)) return body;
			break;
		case "r":
			if (body === "Inf") return "9e999";
			if (body === "-Inf") return "-9e999";
			if (/^-?[\d.]+(e[-+]?\d+)?$/i.test(body)) return `CAST(${literal(body)} AS REAL)`;
			break;
		case "t":
			if (/^([0-9A-F]{2})*$/i.test(body)) return `CAST(X'${body}' AS TEXT)`;
			break;
		case "b":
			if (/^([0-9A-F]{2})*$/i.test(body)) return `X'${body}'`;
			break;
	}
	throw new RouteError(400, "migrate_d1.bad_request", `invalid key value ${JSON.stringify(tagged)}`);
}

function realBits(text) {
	const value = text === "Inf" ? Number.POSITIVE_INFINITY : text === "-Inf" ? Number.NEGATIVE_INFINITY : Number(text);
	const view = new DataView(new ArrayBuffer(8));
	view.setFloat64(0, value);
	return [...new Uint8Array(view.buffer)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

/** One row of `types, ...values` as the digest text. Orange's copy of this function must match. */
export function digestRow(types, values) {
	let row = "";
	for (let index = 0; index < types.length; index += 1) {
		const type = types[index];
		if (index > 0) row += ",";
		row += type === "r" ? `r${realBits(values[index])}` : type === "n" ? "n" : `${type}${values[index]}`;
	}
	return row;
}

async function digest(db, schema, body) {
	const table = schema.tables.find((candidate) => candidate.name === body.table && !candidate.virtual);
	if (table === undefined) throw new RouteError(404, "migrate_d1.unknown_table", `no table named ${body.table}`);
	const limit = Math.max(1, Math.min(Number(body.limit) || 1000, 100_000));
	const t = quote(table.name);
	const keys = keyColumns(table);
	const columns = table.columns.map((column) => `${t}.${quote(column.name)}`);
	let after = "1";
	if (body.after !== undefined && body.after !== null) {
		const values = Array.isArray(body.after) ? body.after : [body.after];
		if (values.length !== keys.length) throw new RouteError(400, "migrate_d1.bad_request", "after does not match the key");
		after = `(${keys.map((key) => `${t}.${key}`).join(", ")}) > (${values.map(untagLiteral).join(", ")})`;
	}
	const types = columns.map((column) => `substr(typeof(${column}), 1, 1)`).join(" || ");
	const order = keys.map((key) => `${t}.${key}`).join(", ");
	const rows = await db
		.prepare(`SELECT json_array(${keys.map((key) => tag(`${t}.${key}`)).join(", ")}) AS k, ${types} AS ty${columns.map((column, index) => `, ${exact(column)} AS v${index}`).join("")} FROM ${t} WHERE ${after} ORDER BY ${order} LIMIT ${limit}`)
		.raw();
	const text = rows.map((row) => digestRow(row[1], row.slice(2))).join("\n");
	const last = rows.length === 0 ? null : JSON.parse(rows.at(-1)[0]);
	return { bytes: text.length, count: rows.length, digest: await sha256(text), last: last === null ? null : table.withoutRowid ? last : last[0] };
}

// What the CLI warns about or refuses before the freeze. Nothing changes.
//
// `rowids`: tables whose rowid is not an INTEGER PRIMARY KEY, and whose rowids have gaps. D1's
// export numbers their rows again from 1, so a rowid that the app stored points elsewhere after.
// `indexes` (when asked): an estimate of each index's size, as rows times the average key of 1,000
// rows. Orange builds each index in one commit, and a commit holds at most 128 MiB.
async function preflight(db, body) {
	const schema = await readSchema(db);
	const rowids = [];
	for (const table of schema.tables.filter((candidate) => !candidate.virtual && !candidate.withoutRowid && candidate.name !== "sqlite_sequence")) {
		const keys = await db.prepare("SELECT type FROM pragma_table_xinfo(?) WHERE pk > 0").bind(table.name).all();
		if (keys.results.length === 1 && String(keys.results[0].type).toUpperCase() === "INTEGER") continue;
		const row = await db.prepare(`SELECT max(${rowidName(table)}) AS max, count(*) AS rows FROM ${quote(table.name)}`).first();
		if (row.rows > 0 && row.max !== row.rows) rowids.push({ max: row.max, rows: row.rows, table: table.name });
	}
	const indexes = [];
	if (body.indexes === true) {
		const counts = new Map();
		for (const index of schema.objects.filter((object) => object.type === "index")) {
			const { results } = await db.prepare("SELECT name FROM pragma_index_xinfo(?) WHERE key = 1 AND cid >= 0").bind(index.name).all();
			if (!counts.has(index.tableName)) counts.set(index.tableName, (await db.prepare(`SELECT count(*) AS n FROM ${quote(index.tableName)}`).first()).n);
			const lengths = results.length === 0 ? "8" : results.map(({ name }) => `coalesce(length(${quote(name)}), 1)`).join(" + ");
			const sample = await db.prepare(`SELECT avg(${lengths}) AS bytes FROM (SELECT * FROM ${quote(index.tableName)} LIMIT 1000)`).first();
			// Each entry also holds the row's key and a few bytes of record header.
			indexes.push({ bytes: Math.round(counts.get(index.tableName) * ((sample.bytes ?? 0) + 12)), name: index.name, table: index.tableName });
		}
	}
	return { indexes, rowids };
}

// Checks that this Worker can reach Orange at `url`, the way forwarded queries will, before the move
// points every query there.
async function probe(binding, token, body) {
	const url = String(body.url ?? "");
	if (!/^https?:\/\//.test(url)) throw new RouteError(400, "migrate_d1.bad_request", "probe needs the Orange Worker's url");
	const started = Date.now();
	try {
		const response = await fetch(new URL(`${routePrefix}${encodeURIComponent(binding)}/status`, url), {
			body: "{}",
			headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
			method: "POST",
			signal: AbortSignal.timeout(5_000),
		});
		await response.body?.cancel();
		return { ms: Date.now() - started, ok: response.ok, status: response.status };
	} catch (error) {
		return { error: String(error?.message ?? error), ms: Date.now() - started, ok: false, status: 0 };
	}
}

// --- Routes -----------------------------------------------------------------------------------------

class RouteError extends Error {
	constructor(status, code, message) {
		super(message);
		this.status = status;
		this.code = code;
	}
}

function tokenMatches(request, token) {
	const received = new TextEncoder().encode(request.headers.get("authorization") ?? "");
	const expected = new TextEncoder().encode(`Bearer ${token}`);
	if (received.byteLength !== expected.byteLength) return false;
	return crypto.subtle.timingSafeEqual(received, expected);
}

function failure(status, code, message) {
	return Response.json({ error: { code, message } }, { status });
}

// `digest` runs many times during a check, and each schema read is 2 + tables queries. It reuses a
// schema read in the last second. The CLI compares the schema hash itself before the switch.
const schemaCache = new Map();
async function cachedSchema(db, binding) {
	const hit = schemaCache.get(binding);
	if (hit !== undefined && Date.now() - hit.at < 1_000) return hit.schema;
	const schema = await readSchema(db);
	schemaCache.set(binding, { at: Date.now(), schema });
	return schema;
}

async function answer(db, op, body, binding, token) {
	switch (op) {
		case "state":
			return readState(db);
		case "schema":
			return readSchema(db);
		case "probe":
			return probe(binding, token, body);
		case "preflight":
			return preflight(db, body);
		case "freeze":
			return freeze(db, binding, body);
		case "extend":
			return extend(db, body);
		case "unfreeze":
			return unfreeze(db, body);
		case "moved":
			return moved(db, binding, body);
		case "digest":
			return digest(db, await cachedSchema(db, binding), body);
		default:
			throw new RouteError(404, "migrate_d1.unknown_op", `no D1 migration route named ${op}`);
	}
}

/**
 * `POST /__migrate-d1/<BINDING>/<op>` with a JSON body. Returns undefined for other requests, so the
 * app gets them. `env` must hold the unwrapped bindings.
 */
export function d1MigrationRoute(request, env, { bindings, token }) {
	if (!request.url.includes(routePrefix)) return undefined;
	const { pathname } = new URL(request.url);
	if (!pathname.startsWith(routePrefix)) return undefined;
	return (async () => {
		if (typeof token !== "string" || token === "") {
			return failure(503, "migrate_d1.not_configured", "WORKER_MIGRATOR_TOKEN is not set on this Worker");
		}
		if (!tokenMatches(request, token)) return failure(401, "migrate_d1.unauthorized", "missing or wrong migrator token");
		if (request.method !== "POST") return failure(405, "migrate_d1.method", "use POST");
		const [binding, op, ...rest] = pathname.slice(routePrefix.length).split("/").map(decodeURIComponent);
		if (rest.length > 0 || !bindings.includes(binding)) {
			return failure(404, "migrate_d1.unknown_binding", `no D1 binding named "${binding}"`);
		}
		const db = env[binding];
		try {
			const text = await request.text();
			const started = Date.now();
			const result = await answer(db, op, text === "" ? {} : JSON.parse(text), binding, token);
			return Response.json({ ...result, workerMs: Date.now() - started });
		} catch (error) {
			if (error instanceof RouteError) return failure(error.status, error.code, error.message);
			return failure(500, "migrate_d1.failed", String(error?.message ?? error));
		}
	})();
}

// --- The binding wrapper ------------------------------------------------------------------------------

function isMissingStateTable(error) {
	return String(error?.message ?? error).includes(`no such table: ${stateTable}`);
}

function isFrozen(error) {
	return String(error?.message ?? error).includes(frozenMessage);
}

// D1 sends a parameter the way workerd's D1 client does: bytes as an array, booleans as numbers.
function forwardParam(value) {
	if (value instanceof ArrayBuffer) return { $blob: [...new Uint8Array(value)] };
	if (ArrayBuffer.isView(value)) return { $blob: [...new Uint8Array(value.buffer, value.byteOffset, value.byteLength)] };
	if (typeof value === "boolean") return value ? 1 : 0;
	return value;
}

class FencedD1 {
	#binding;
	#real;
	#token;
	#noMigrationUntil = 0;

	constructor(binding, real, token) {
		this.#binding = binding;
		this.#real = real;
		this.#token = token;
	}

	prepare(sql) {
		return new FencedStatement(this, sql, [], this.#real.prepare(sql));
	}

	batch(statements) {
		return this.run(statements, "batch");
	}

	exec(sql) {
		return this.run([{ params: [], real: undefined, sql }], "exec");
	}

	withSession() {
		// A bookmark can't follow a query to Orange, so every query here runs on the primary, which
		// is the strongest order. The session's own bookmark is not tracked.
		const session = {
			batch: (statements) => this.batch(statements),
			getBookmark: () => null,
			prepare: (sql) => this.prepare(sql),
		};
		return session;
	}

	dump() {
		return this.#real.dump();
	}

	async #direct(statements, mode) {
		if (mode === "exec") return this.#real.exec(statements[0].sql);
		if (mode === "raw") return statements[0].real.raw(statements[0].options);
		if (mode === "first") return statements[0].real.first(statements[0].column);
		if (mode === "run") return statements[0].real.run();
		if (mode === "all") return statements[0].real.all();
		return this.#real.batch(statements.map((statement) => statement.real));
	}

	// The state, or null before any move and after a move that stopped.
	async #readState() {
		try {
			return await this.#real.prepare(`SELECT state, url FROM ${stateTable}`).first();
		} catch (error) {
			if (isMissingStateTable(error)) return null;
			throw error;
		}
	}

	// Runs the statements on Cloudflare with the state read last, in the same transaction, so a result
	// that comes back without `moved` happened before the switch, and a batch that fails on a missing
	// state table rolls back whole. `raw` and `exec` can't share a batch, and a statement that ran must
	// never run again, so they read the state first. A write that races the switch still fails on the
	// freeze triggers, and then runs on Orange.
	async #withState(statements, mode) {
		if (mode === "raw" || mode === "exec") {
			const state = await this.#readState();
			if (state?.state === "moved") return { result: undefined, state };
			return { result: await this.#direct(statements, mode), state };
		}
		const probe = this.#real.prepare(`SELECT state, url FROM ${stateTable}`);
		const results = await this.#real.batch([...statements.map((statement) => statement.real), probe]);
		const state = results.at(-1).results[0];
		const own = results.slice(0, -1);
		if (mode === "batch") return { result: own, state };
		if (mode === "first") {
			const row = own[0].results[0] ?? null;
			const column = statements[0].column;
			if (row !== null && column !== undefined && !(column in row)) throw new Error(`D1_COLUMN_NOTFOUND: Column not found (${column})`);
			return { result: row === null ? null : column === undefined ? row : row[column], state };
		}
		return { result: own[0], state };
	}

	async run(statements, mode) {
		for (;;) {
			if (Date.now() < this.#noMigrationUntil) {
				try {
					return await this.#direct(statements, mode);
				} catch (error) {
					if (!isFrozen(error)) throw error;
					this.#noMigrationUntil = 0;
					continue;
				}
			}
			let outcome;
			try {
				outcome = await this.#withState(statements, mode);
			} catch (error) {
				if (isMissingStateTable(error)) {
					this.#noMigrationUntil = Date.now() + noMigrationTtlMs;
					continue;
				}
				if (!isFrozen(error)) throw error;
				// A write hit the freeze, so its batch rolled back. After the switch it runs on Orange.
				// During the freeze the app gets the freeze's own error, which names the move.
				const state = await this.#real.prepare(`SELECT state, url FROM ${stateTable}`).first();
				if (state?.state === "moved") return this.#forward(statements, mode, state.url);
				throw error;
			}
			if (outcome.state?.state !== "moved") return outcome.result;
			return this.#forward(statements, mode, outcome.state.url);
		}
	}

	async #forward(statements, mode, url) {
		const response = await fetch(new URL(`${routePrefix}${encodeURIComponent(this.#binding)}/query`, url), {
			body: JSON.stringify({
				mode,
				statements: statements.map(({ column, options, params, sql }) => ({ column, options, params: params.map(forwardParam), sql })),
			}),
			headers: { authorization: `Bearer ${this.#token}`, "content-type": "application/json" },
			method: "POST",
		});
		const body = await response.json().catch(() => undefined);
		if (!response.ok || body === undefined) {
			const message = body?.error?.message ?? `Orange answered ${response.status}`;
			throw new Error(message.startsWith("D1_") ? message : `D1_ERROR: ${message}`);
		}
		return body.result;
	}
}

class FencedStatement {
	constructor(database, sql, params, real) {
		this.database = database;
		this.sql = sql;
		this.params = params;
		this.real = real;
	}

	bind(...params) {
		return new FencedStatement(this.database, this.sql, params, this.real.bind(...params));
	}

	first(column) {
		return this.database.run([{ ...this, column }], "first");
	}

	run() {
		return this.database.run([this], "run");
	}

	all() {
		return this.database.run([this], "all");
	}

	raw(options) {
		return this.database.run([{ ...this, options }], "raw");
	}
}

// `batch()` takes the wrapped statements, so it needs the real ones underneath.
Object.defineProperty(FencedStatement.prototype, Symbol.toStringTag, { value: "D1PreparedStatement" });

/** A copy of `env` whose D1 bindings follow the database to Orange once it has moved. */
export function withFencedD1(env, { bindings, token }) {
	if (env === undefined || env === null) return env;
	const wrapped = { ...env };
	for (const binding of bindings) {
		const real = env[binding];
		if (real !== undefined) wrapped[binding] = new FencedD1(binding, real, token);
	}
	return wrapped;
}
