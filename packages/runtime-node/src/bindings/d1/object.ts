import { D1_SESSION_COMMIT_TOKEN_HTTP_HEADER } from "./database.js";
import { D1Import, D1ImportError, isStorageBusy } from "./import.js";
import { internalTurnDatabase } from "../durable-objects/storage.js";
import type { InternalObjectState } from "../internal-objects.js";
import { errorMessage } from "../unknown-values.js";

// The D1 backend: one internal Durable Object per database, holding the data
// in its SQLite storage. It mirrors wrangler dev's Miniflare D1 backend, which
// also runs each request in one storage transaction on a Durable Object.
// https://github.com/cloudflare/workers-sdk/blob/be87ff0382c53a294e948e49419d25d653c50e86/packages/miniflare/src/workers/d1/database.worker.ts#L119-L237

type D1Value = number | string | null | number[];

interface D1Query {
	params: D1Value[];
	sql: string;
}

type ResultsFormat = "ARRAY_OF_OBJECTS" | "NONE" | "ROWS_AND_COLUMNS";

class D1RequestError extends Error {}

function isD1Value(value: unknown): value is D1Value {
	return (
		value === null ||
		typeof value === "number" ||
		typeof value === "string" ||
		(Array.isArray(value) && value.every((byte) => typeof byte === "number"))
	);
}

function parseQuery(value: unknown): D1Query {
	if (typeof value !== "object" || value === null || Array.isArray(value)) {
		throw new D1RequestError("Invalid D1 query");
	}
	const sql: unknown = Reflect.get(value, "sql");
	const params: unknown = Reflect.get(value, "params");
	if (typeof sql !== "string") throw new D1RequestError("Invalid D1 query");
	if (params === undefined || params === null) return { params: [], sql };
	if (!Array.isArray(params) || !params.every(isD1Value)) {
		throw new D1RequestError("Invalid D1 query parameters");
	}
	return { params, sql };
}

function parseResultsFormat(value: string | null): ResultsFormat {
	return value === "NONE" || value === "ROWS_AND_COLUMNS"
		? value
		: "ARRAY_OF_OBJECTS";
}

// A byte array parameter is a BLOB, and a BLOB result becomes a byte array.
function toSqlParameter(value: D1Value): unknown {
	return Array.isArray(value) ? new Uint8Array(value) : value;
}

function toD1Value(value: unknown): D1Value {
	if (value instanceof ArrayBuffer) return Array.from(new Uint8Array(value));
	if (value === null || typeof value === "number" || typeof value === "string") {
		return value;
	}
	throw new Error("D1 query returned an unsupported column value");
}

function failure(error: unknown): Response {
	return Response.json({ error: errorMessage(error), success: false }, { status: 500 });
}

type DatabasePosition = { lastRowId: number; size: number; totalChanges: number };

export class D1DatabaseObject {
	readonly #state: InternalObjectState;
	readonly #import: D1Import;
	#bookmarkSequence = 0;

	constructor(state: InternalObjectState) {
		this.#state = state;
		this.#import = new D1Import(() => internalTurnDatabase(state.storage));
	}

	async fetch(request: Request): Promise<Response> {
		const url = new URL(request.url);
		if (request.method === "POST" && url.pathname.startsWith("/migrate/")) {
			return this.#migrate(url.pathname.slice("/migrate/".length), request);
		}
		if (
			request.method !== "POST" ||
			(url.pathname !== "/query" && url.pathname !== "/execute")
		) {
			return new Response(null, { status: 404 });
		}
		let queries: D1Query[];
		try {
			const body: unknown = await request.json();
			queries = Array.isArray(body) ? body.map(parseQuery) : [parseQuery(body)];
		} catch (error: unknown) {
			return failure(error);
		}
		const format = parseResultsFormat(url.searchParams.get("resultsFormat"));
		if (this.#import.unfinished()) {
			return failure(
				new Error("This D1 database has an unfinished copy from Cloudflare, so Orange won't serve its partial data. Finish it with `orange migrate d1`, or replace it with `orange migrate d1 --replace`."),
			);
		}
		try {
			const results = this.#transaction(queries, format);
			return Response.json(results, {
				headers: { [D1_SESSION_COMMIT_TOKEN_HTTP_HEADER]: this.#nextBookmark() },
			});
		} catch (error: unknown) {
			return failure(error);
		}
	}

	// Steps of a copy from Cloudflare, from Orange's token-protected migration route only.
	async #migrate(op: string, request: Request): Promise<Response> {
		try {
			const body = (await request.json()) as Record<string, unknown>;
			const binding = String(body.binding ?? "");
			switch (op) {
				case "status":
					return Response.json(this.#import.status());
				case "schema":
					return Response.json(this.#import.schema());
				case "begin":
					return Response.json(await this.#import.begin(binding, String(body.export ?? ""), body.replace === true));
				case "apply":
					return Response.json(await this.#import.apply(body as unknown as Parameters<D1Import["apply"]>[0]));
				case "digest":
					return Response.json(this.#import.digest(body as unknown as Parameters<D1Import["digest"]>[0]));
				case "discard":
					return Response.json(await this.#import.discard(binding));
				case "finish":
					return Response.json(await this.#import.finish());
				default:
					return Response.json({ error: { code: "migrate_d1.unknown_op", message: `no D1 migration step named ${op}` } }, { status: 404 });
			}
		} catch (error: unknown) {
			if (error instanceof D1ImportError) {
				return Response.json({ error: { code: error.code, message: error.message } }, { status: error.status });
			}
			if (isStorageBusy(error)) return storageBusy(error);
			return Response.json({ error: { code: "migrate_d1.failed", message: errorMessage(error) } }, { status: 500 });
		}
	}

	// Queries that hold only comments are dropped, and an empty request fails.
	#transaction(queries: D1Query[], format: ResultsFormat): unknown[] {
		const statements = queries.filter(
			(query) => query.sql.replace(/^\s+--.*/gm, "").trim().length > 0,
		);
		if (statements.length === 0) throw new Error("No SQL statements detected.");
		return this.#state.storage.transactionSync(() => {
			// Nothing else runs in this transaction, so each statement starts where the last one
			// ended. Reading this state costs more than a small INSERT, and a large import has many.
			let position = this.#position();
			return statements.map((query) => {
				const { after, result } = this.#query(query, format, position);
				position = after;
				return result;
			});
		});
	}

	#position(): DatabasePosition {
		const sql = this.#state.storage.sql;
		const row = sql
			.exec<{ lastRowId: number; totalChanges: number }>(
				"SELECT total_changes() AS totalChanges, last_insert_rowid() AS lastRowId",
			)
			.one();
		return { lastRowId: row.lastRowId, size: sql.databaseSize, totalChanges: row.totalChanges };
	}

	#query(
		query: D1Query,
		format: ResultsFormat,
		before: DatabasePosition,
	): { after: DatabasePosition; result: unknown } {
		const sql = this.#state.storage.sql;
		const startedAt = performance.now();
		const cursor = sql.exec(query.sql, ...query.params.map(toSqlParameter));
		const columns = cursor.columnNames;
		const rows = Array.from(cursor.raw(), (row) => row.map(toD1Value));
		const duration = performance.now() - startedAt;
		const after = this.#position();
		const changes = after.totalChanges - before.totalChanges;
		return {
			after,
			result: {
				meta: {
					changed_db:
						changes !== 0 || after.lastRowId !== before.lastRowId || after.size !== before.size,
					changes,
					duration,
					last_row_id: after.lastRowId,
					rows_read: cursor.rowsRead,
					rows_written: cursor.rowsWritten,
					served_by: "open-orange.db",
					served_by_primary: true,
					size_after: after.size,
					timings: { sql_duration_ms: duration },
				},
				// Like Miniflare, NONE still returns rows as objects.
				results:
					format === "ROWS_AND_COLUMNS"
						? { columns, rows }
						: rows.map((row) =>
								Object.fromEntries(columns.map((name, index) => [name, row[index]])),
							),
				success: true,
			},
		};
	}

	// Every query reaches the single local primary, so a session bookmark only
	// has to increase.
	#nextBookmark(): string {
		this.#bookmarkSequence += 1;
		return `${Date.now().toString(16).padStart(16, "0")}-${this.#bookmarkSequence
			.toString(16)
			.padStart(8, "0")}`;
	}
}

/** The answer to a migration step that the Engine's storage could not take in time. */
export function storageBusy(error: unknown): Response {
	return Response.json(
		{
			error: {
				code: "migrate_d1.storage_busy",
				message: `The Engine's storage could not keep up, so this database restarts from its last durable state: ${errorMessage(error)}`,
				retryAfterMs: 2_000,
			},
		},
		{ status: 503 },
	);
}
