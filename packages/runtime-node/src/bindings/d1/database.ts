// The D1 client API. It follows workerd's JavaScript D1 binding, which sends
// statements to a D1 backend over HTTP. OpenOrange's backend is an internal
// Durable Object (see ./object.ts), reached through `fetcher`.
// Orange runs without the d1_binding_jsrpc compatibility flag, so only the
// HTTP `/query` and `/execute` paths of the upstream client are ported.
// https://github.com/cloudflare/workerd/blob/b73ce3ae105c35bafaaad864095079524573a465/src/cloudflare/internal/d1-api.ts#L155-L1053

import { isTypedArray } from "node:util/types";
import { isRecord } from "../unknown-values.js";

export interface D1Fetcher {
	fetch(input: string, init: RequestInit): Promise<Response>;
}

export interface D1Meta {
	changed_db: boolean;
	changes: number;
	duration: number;
	last_row_id: number;
	rows_read: number;
	rows_written: number;
	served_by_primary?: boolean;
	size_after: number;
	timings?: { sql_duration_ms: number };
	[key: string]: unknown;
}

export interface D1Result<T = unknown> {
	error?: never;
	meta: D1Meta;
	results: T[];
	success: true;
}

type D1Row = Record<string, unknown>;

interface D1UpstreamSuccess {
	meta: D1Meta;
	results?: D1Row[] | { columns: string[]; rows: unknown[][] };
	success: true;
}

interface D1UpstreamFailure {
	error: string;
	success: false;
}

type D1UpstreamResponse = D1UpstreamSuccess | D1UpstreamFailure;
type NonEmpty<T> = [T, ...T[]];

export interface D1ExecResult {
	count: number;
	duration: number;
}

type ResultsFormat = "ARRAY_OF_OBJECTS" | "ROWS_AND_COLUMNS" | "NONE";

const D1_SESSION_CONSTRAINT_FIRST_PRIMARY = "first-primary";
const D1_SESSION_CONSTRAINT_FIRST_UNCONSTRAINED = "first-unconstrained";
export const D1_SESSION_COMMIT_TOKEN_HTTP_HEADER = "x-cf-d1-session-commit-token";

// A failure from the actor or the gateway instead of from SQL. Its body is a Rivet error or a proxy's
// page, not a D1 result. Undefined when the D1 object itself reported the failure.
async function actorFailureMessage(response: Response): Promise<string | undefined> {
	const text = await response.text();
	let detail = text.slice(0, 500);
	try {
		const body: unknown = JSON.parse(text);
		if (isRecord(body) && body.error) return undefined;
		if (isRecord(body) && typeof body.group === "string" && typeof body.code === "string") {
			const reason = isRecord(body.metadata) && typeof body.metadata.error === "string" ? ` (${body.metadata.error})` : "";
			detail = `${body.group}.${body.code}: ${String(body.message)}${reason}`;
		}
	} catch {
		// Not JSON, so the text is the detail.
	}
	return `The D1 database could not answer (status ${response.status}): ${detail}`;
}

function d1Error(prefix: string, message: string): Error {
	return new Error(`${prefix}: ${message}`, { cause: new Error(message) });
}

const d1Fetchers = new WeakMap<object, D1Fetcher>();

/** The D1 actor behind a binding, for Orange's migration route. Undefined for anything else. */
export function d1DatabaseFetcher(binding: unknown): D1Fetcher | undefined {
	return typeof binding === "object" && binding !== null ? d1Fetchers.get(binding) : undefined;
}

export class D1Database {
	readonly #fetcher: D1Fetcher;
	readonly #primary: D1DatabaseSessionAlwaysPrimary;

	constructor(fetcher: D1Fetcher) {
		this.#fetcher = fetcher;
		this.#primary = new D1DatabaseSessionAlwaysPrimary(fetcher);
		d1Fetchers.set(this, fetcher);
	}

	prepare(query: string): D1PreparedStatement {
		return new D1PreparedStatement(this.#primary, query);
	}

	batch<T = unknown>(statements: D1PreparedStatement[]): Promise<D1Result<T>[]> {
		return this.#primary.batch(statements);
	}

	exec(query: string): Promise<D1ExecResult> {
		return this.#primary.exec(query);
	}

	withSession(constraintOrBookmark?: string): D1DatabaseSession {
		let value = constraintOrBookmark?.trim();
		if (value === undefined || value === "") {
			value = D1_SESSION_CONSTRAINT_FIRST_UNCONSTRAINED;
		}
		return new D1DatabaseSession(this.#fetcher, value);
	}

	// Workerd requires the d1_binding_jsrpc compatibility flag for query(), and
	// Orange does not apply compatibility flags.
	// https://github.com/cloudflare/workerd/blob/b73ce3ae105c35bafaaad864095079524573a465/src/cloudflare/internal/d1-api.ts#L210-L218
	async query(_request: unknown): Promise<never> {
		throw new Error(
			"D1_ERROR: D1Database.query() requires the d1_binding_jsrpc compatibility flag. Enable d1_binding_jsrpc before calling query().",
		);
	}

	/** @deprecated */
	dump(): Promise<ArrayBuffer> {
		return this.#primary.dump();
	}
}

export class D1DatabaseSession {
	protected readonly fetcher: D1Fetcher;
	protected bookmarkOrConstraint: string | null;

	constructor(fetcher: D1Fetcher, bookmarkOrConstraint: string | null) {
		this.fetcher = fetcher;
		if (bookmarkOrConstraint === null) {
			this.bookmarkOrConstraint = null;
		} else {
			this.bookmarkOrConstraint = bookmarkOrConstraint.trim();
			if (this.bookmarkOrConstraint === "") {
				throw new Error("D1_SESSION_ERROR: invalid bookmark or constraint");
			}
		}
	}

	// Keep only the most recent bookmark seen by concurrent queries.
	protected updateBookmark(newBookmark: string): string | null {
		const trimmed = newBookmark.trim();
		if (trimmed === "") return this.getBookmark();
		const current = this.getBookmark();
		if (current === null || current.localeCompare(trimmed) < 0) {
			this.bookmarkOrConstraint = trimmed;
		}
		return this.getBookmark();
	}

	prepare(sql: string): D1PreparedStatement {
		return new D1PreparedStatement(this, sql);
	}

	async batch<T = unknown>(
		statements: D1PreparedStatement[],
	): Promise<D1Result<T>[]> {
		const results = await this.sendOrThrow(
			"/query",
			statements.map((statement) => statement.statement),
			statements.map((statement) => statement.params),
			"ROWS_AND_COLUMNS",
		);
		return results.map((result) => toD1Result<T>(result));
	}

	getBookmark(): string | null {
		switch (this.bookmarkOrConstraint) {
			case D1_SESSION_CONSTRAINT_FIRST_UNCONSTRAINED:
			case D1_SESSION_CONSTRAINT_FIRST_PRIMARY:
				return null;
			default:
				return this.bookmarkOrConstraint;
		}
	}

	protected async wrappedFetch(input: string, init: RequestInit): Promise<Response> {
		const headers = new Headers(init.headers);
		if (this.bookmarkOrConstraint) {
			headers.set(D1_SESSION_COMMIT_TOKEN_HTTP_HEADER, this.bookmarkOrConstraint);
		}
		const response = await this.fetcher.fetch(input, { ...init, headers });
		const newBookmark = response.headers.get(D1_SESSION_COMMIT_TOKEN_HTTP_HEADER);
		if (newBookmark) this.updateBookmark(newBookmark);
		return response;
	}

	async sendOrThrow(
		endpoint: string,
		query: string | string[],
		params: unknown[],
		resultsFormat: ResultsFormat,
	): Promise<NonEmpty<D1UpstreamSuccess>> {
		const results = await this.send(endpoint, query, params, resultsFormat);
		const [first, ...rest] = Array.isArray(results) ? results : [results];
		if (first === undefined) throw d1Error("D1_ERROR", "D1 returned no results");
		if (!first.success) throw d1Error("D1_ERROR", first.error);
		const successes: NonEmpty<D1UpstreamSuccess> = [first];
		for (const result of rest) {
			if (!result.success) throw d1Error("D1_ERROR", result.error);
			successes.push(result);
		}
		return successes;
	}

	async send(
		endpoint: string,
		query: string | string[],
		params: unknown[],
		resultsFormat: ResultsFormat,
	): Promise<D1UpstreamResponse[] | D1UpstreamResponse> {
		const body = JSON.stringify(
			Array.isArray(query)
				? query.map((sql, index) => ({ params: params[index], sql }))
				: { params, sql: query },
		);
		const url = new URL(endpoint, "http://d1");
		url.searchParams.set("resultsFormat", resultsFormat);
		const response = await this.wrappedFetch(url.href, {
			body,
			headers: { "content-type": "application/json" },
			method: "POST",
		});
		const actorFailure = response.ok ? undefined : await actorFailureMessage(response.clone());
		if (actorFailure !== undefined) throw d1Error("D1_ERROR", actorFailure);
		try {
			const answer = await toJson(response);
			return Array.isArray(answer)
				? answer.map((result: unknown) => parseD1Response(result))
				: parseD1Response(answer);
		} catch (error: unknown) {
			const cause = error instanceof Error ? error.cause : undefined;
			const message =
				(cause instanceof Error ? cause.message : undefined) ||
				(error instanceof Error ? error.message : undefined) ||
				"Something went wrong";
			throw d1Error("D1_ERROR", message);
		}
	}
}

class D1DatabaseSessionAlwaysPrimary extends D1DatabaseSession {
	constructor(fetcher: D1Fetcher) {
		super(fetcher, null);
	}

	protected override updateBookmark(_newBookmark: string): string | null {
		return null;
	}

	override getBookmark(): string | null {
		return null;
	}

	// Workerd splits exec() input by line and sends each line as a statement.
	async exec(query: string): Promise<D1ExecResult> {
		const lines = query.trim().split("\n");
		const execResults = await this.send("/execute", lines, [], "NONE");
		const results = Array.isArray(execResults) ? execResults : [execResults];
		let duration = 0;
		for (const [index, result] of results.entries()) {
			if (!result.success) {
				const message = result.error || "Something went wrong";
				const lineNumber = index + 1;
				throw d1Error(
					"D1_EXEC_ERROR",
					`Error in line ${lineNumber}: ${lines[lineNumber - 1]}: ${message}`,
				);
			}
			duration += result.meta.duration;
		}
		return { count: results.length, duration };
	}

	async dump(): Promise<ArrayBuffer> {
		const response = await this.wrappedFetch("http://d1/dump", {
			headers: { "content-type": "application/json" },
			method: "POST",
		});
		if (response.status !== 200) {
			try {
				const error: unknown = await response.json();
				throw d1Error("D1_DUMP_ERROR", isRecord(error) ? String(error.error) : "");
			} catch {
				throw new Error(`D1_DUMP_ERROR: Status + ${response.status}`, {
					cause: new Error(`Status ${response.status}`),
				});
			}
		}
		return await response.arrayBuffer();
	}
}

export class D1PreparedStatement {
	readonly #session: D1DatabaseSession;
	readonly statement: string;
	readonly params: unknown[];

	constructor(session: D1DatabaseSession, statement: string, values?: unknown[]) {
		this.#session = session;
		this.statement = statement;
		this.params = values ?? [];
	}

	bind(...values: unknown[]): D1PreparedStatement {
		const transformed = values.map((value: unknown): unknown => {
			const type = typeof value;
			if (type === "number" || type === "string") return value;
			if (type === "boolean") return value ? 1 : 0;
			if (type === "object") {
				if (value === null) return value;
				if (
					Array.isArray(value) &&
					value.every((byte: unknown) => typeof byte === "number" && byte >= 0 && byte < 256)
				) {
					return value;
				}
				if (value instanceof ArrayBuffer) return Array.from(new Uint8Array(value));
				if (ArrayBuffer.isView(value)) {
					// A DataView has no indexed elements, so workerd's Array.from turns it into [].
					return isTypedArray(value) ? Array.from<unknown>(value) : [];
				}
			}
			throw d1Error(
				"D1_TYPE_ERROR",
				`Type '${type}' not supported for value '${String(value)}'`,
			);
		});
		return new D1PreparedStatement(this.#session, this.statement, transformed);
	}

	async first<T = unknown>(columnName?: string): Promise<T | null> {
		const [info] = await this.#session.sendOrThrow(
			"/query",
			this.statement,
			this.params,
			"ROWS_AND_COLUMNS",
		);
		const [first] = toRows(info);
		if (first === undefined) return null;
		if (columnName === undefined) return asCallerType<T>(first);
		if (first[columnName] === undefined) {
			throw new Error(`D1_COLUMN_NOTFOUND: Column not found (${columnName})`, {
				cause: new Error("Column not found"),
			});
		}
		return asCallerType<T>(first[columnName]);
	}

	// Without d1_binding_jsrpc, workerd returns the backend's run() response
	// as-is. The backend still includes `results` for NONE.
	async run<T = Record<string, unknown>>(): Promise<D1Result<T>> {
		const [info] = await this.#session.sendOrThrow(
			"/execute",
			this.statement,
			this.params,
			"NONE",
		);
		return toD1Result<T>(info);
	}

	async all<T = Record<string, unknown>>(): Promise<D1Result<T>> {
		const [info] = await this.#session.sendOrThrow(
			"/query",
			this.statement,
			this.params,
			"ROWS_AND_COLUMNS",
		);
		return toD1Result<T>(info);
	}

	async raw<T = unknown[]>(options?: { columnNames?: boolean }): Promise<T[]> {
		const [info] = await this.#session.sendOrThrow(
			"/query",
			this.statement,
			this.params,
			"ROWS_AND_COLUMNS",
		);
		const results = info.results;
		if (results === undefined) return [];
		if (Array.isArray(results)) {
			const raw: unknown[] = [];
			for (const row of results) {
				if (options?.columnNames && raw.length === 0) {
					raw.push(Object.keys(row));
				}
				raw.push(Object.values(row));
			}
			return asCallerType<T[]>(raw);
		}
		return asCallerType<T[]>([
			...(options?.columnNames ? [results.columns] : []),
			...results.rows,
		]);
	}
}

// Like workerd's D1 binding, the caller declares the row type T.
function asCallerType<T>(value: unknown): T {
	// SAFETY: The rows are JSON values decoded from SQLite, and TypeScript
	// cannot check them against a type that exists only at the call site.
	return value as T;
}

function toRows(response: D1UpstreamSuccess): D1Row[] {
	const results = response.results;
	if (results === undefined) return [];
	if (Array.isArray(results)) return results;
	const { columns, rows } = results;
	return rows.map((row) =>
		Object.fromEntries(
			row.map((cell, index): [string, unknown] => [String(columns[index]), cell]),
		),
	);
}

function toD1Result<T>(response: D1UpstreamSuccess): D1Result<T> {
	return { ...response, results: asCallerType<T[]>(toRows(response)) };
}

// The internal D1 object returns JSON, so each field is checked before use.
function parseD1Response(value: unknown): D1UpstreamResponse {
	if (!isRecord(value)) throw new Error("D1 response is not an object");
	if (value.error) return { error: String(value.error), success: false };
	const response: D1UpstreamSuccess = { meta: parseD1Meta(value.meta), success: true };
	if ("results" in value) response.results = parseD1Results(value.results);
	return response;
}

function parseD1Meta(value: unknown): D1Meta {
	if (!isRecord(value)) throw new Error("D1 response meta is not an object");
	const { changed_db, changes, duration, last_row_id, rows_read, rows_written, size_after } =
		value;
	if (
		typeof changed_db !== "boolean" ||
		typeof changes !== "number" ||
		typeof duration !== "number" ||
		typeof last_row_id !== "number" ||
		typeof rows_read !== "number" ||
		typeof rows_written !== "number" ||
		typeof size_after !== "number" ||
		!isOptionalBoolean(value.served_by_primary) ||
		!isOptionalTimings(value.timings)
	) {
		throw new Error("D1 response meta has invalid fields");
	}
	return {
		...value,
		changed_db,
		changes,
		duration,
		last_row_id,
		rows_read,
		rows_written,
		size_after,
	};
}

function isOptionalBoolean(value: unknown): value is boolean | undefined {
	return value === undefined || typeof value === "boolean";
}

function isOptionalTimings(value: unknown): value is D1Meta["timings"] {
	return value === undefined || (isRecord(value) && typeof value.sql_duration_ms === "number");
}

function isString(value: unknown): value is string {
	return typeof value === "string";
}

function isUnknownArray(value: unknown): value is unknown[] {
	return Array.isArray(value);
}

function parseD1Results(value: unknown): D1UpstreamSuccess["results"] {
	if (isUnknownArray(value) && value.every(isRecord)) return value;
	if (isRecord(value)) {
		const { columns, rows } = value;
		if (
			isUnknownArray(columns) &&
			columns.every(isString) &&
			isUnknownArray(rows) &&
			rows.every(isUnknownArray)
		) {
			return { columns, rows };
		}
	}
	throw new Error("D1 response results have an invalid shape");
}

async function toJson(response: Response): Promise<unknown> {
	const body = await response.text();
	try {
		return JSON.parse(body);
	} catch {
		throw new Error(`Failed to parse body as JSON, got: ${body}`);
	}
}
