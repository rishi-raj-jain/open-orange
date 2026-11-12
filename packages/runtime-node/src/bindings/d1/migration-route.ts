import { Buffer } from "node:buffer";
import { timingSafeEqual } from "node:crypto";

import { Request, Response } from "../../globals/http.js";
import { runtimeSettings } from "../../internal/runtime-settings.js";
import { workerUrlSetting } from "../durable-objects/migration-mode.js";
import { D1Database, d1DatabaseFetcher } from "./database.js";
import { dumpAction, DumpError, isFrozenStateRow, splitDump } from "./dump.js";
import { isStorageBusy, type ImportStatement } from "./import.js";

// `POST /__migrate-d1/<BINDING>/<step>` on the Orange Worker, while ORANGE_MIGRATE_WORKER_URL and
// WORKER_MIGRATOR_TOKEN are set. `orange migrate d1` drives the steps:
//
//   status, schema   What Orange holds.
//   begin            Starts a copy of one export, or goes on with it.
//   import           Reads the export from its URL, from the byte Orange holds, and sends its
//                    statements to the D1 actor in commits of about 1 MiB, for about 20 seconds.
//   digest           Checks pages of a table against the digests that Cloudflare computed.
//   discard          Drops a copy that failed its check, so the next begin starts again.
//   finish           Ends the copy. Then the app's queries run here.
//
// After the switch, the prepared Worker on Cloudflare sends the app's queries to `query`, which runs
// them on this Worker's binding, so there is one writer.

const routePrefix = "/__migrate-d1/";
const actorSteps = new Set(["begin", "digest", "discard", "finish", "schema", "status"]);
const importBudgetMs = 20_000;
// A commit of about 1 MiB stays off RivetKit's staged-write path, and far under its 128 MiB commit and
// the Engine's 32 MiB message limits.
const commitBytes = 1024 * 1024;

function failure(status: number, code: string, message: string): Response {
	return Response.json({ error: { code, message } }, { status });
}

class StepFailure extends Error {
	constructor(
		readonly status: number,
		readonly code: string,
		message: string,
	) {
		super(message);
	}
}

function tokenMatches(request: Request, token: string): boolean {
	const received = Buffer.from(request.headers.get("authorization") ?? "");
	const expected = Buffer.from(`Bearer ${token}`);
	return received.byteLength === expected.byteLength && timingSafeEqual(received, expected);
}

interface ForwardedStatement {
	column?: string;
	options?: { columnNames?: boolean };
	params?: unknown[];
	sql: string;
}

function parameter(value: unknown): unknown {
	if (typeof value === "object" && value !== null && Array.isArray((value as { $blob?: unknown }).$blob)) {
		return new Uint8Array((value as { $blob: number[] }).$blob);
	}
	return value;
}

async function runForwarded(database: D1Database, mode: string, statements: ForwardedStatement[]): Promise<unknown> {
	const prepared = statements.map((statement) => database.prepare(statement.sql).bind(...(statement.params ?? []).map(parameter)));
	const [first] = prepared;
	const [statement] = statements;
	if (mode === "exec") return database.exec(statement?.sql ?? "");
	if (first === undefined || statement === undefined) return database.batch(prepared);
	switch (mode) {
		case "first":
			return statement.column === undefined ? first.first() : first.first(statement.column);
		case "run":
			return first.run();
		case "all":
			return first.all();
		case "raw":
			return statement.options?.columnNames === true ? first.raw({ columnNames: true }) : first.raw();
		default:
			return database.batch(prepared);
	}
}

type ActorFetcher = NonNullable<ReturnType<typeof d1DatabaseFetcher>>;

// One step of the D1 actor. A failure keeps the actor's status and code.
async function actor(fetcher: ActorFetcher, binding: string, step: string, body: object): Promise<Record<string, unknown>> {
	let response: Awaited<ReturnType<ActorFetcher["fetch"]>>;
	try {
		response = await fetcher.fetch(`http://d1/migrate/${step}`, {
			body: JSON.stringify({ ...body, binding }),
			headers: { "content-type": "application/json" },
			method: "POST",
		});
	} catch (error: unknown) {
		// The database restarts from its last durable state, and the step can run again from there.
		if (isStorageBusy(error)) {
			throw new StepFailure(503, "migrate_d1.storage_busy", `The Engine's storage could not keep up, so this database restarts from its last durable state: ${error instanceof Error ? error.message : String(error)}`);
		}
		throw error;
	}
	const text = await response.text();
	let parsed: Record<string, unknown> & { error?: { code?: string; message?: string } };
	try {
		parsed = JSON.parse(text) as typeof parsed;
	} catch {
		throw new StepFailure(500, "migrate_d1.failed", `The D1 actor answered ${response.status} to ${step}: ${text.slice(0, 300)}`);
	}
	if (!response.ok) throw new StepFailure(response.status, parsed.error?.code ?? "migrate_d1.failed", parsed.error?.message ?? text.slice(0, 300));
	return parsed;
}

// `bytes 100-199/1000` → its start and the total size.
function contentRange(header: string | null): { start: number; total: number } | undefined {
	const match = /^bytes (\d+)-\d+\/(\d+)$/.exec(header ?? "");
	return match === null ? undefined : { start: Number(match[1]), total: Number(match[2]) };
}

/**
 * Reads the export at `url` from the byte the actor holds, and applies its statements until the
 * export ends or the step's time is up. Each commit names the bytes it covers, so a step that stops
 * anywhere, or a restart of Orange, loses nothing and repeats nothing.
 */
async function importStep(fetcher: ActorFetcher, binding: string, body: Record<string, unknown>): Promise<unknown> {
	const url = String(body.url ?? "");
	if (!/^https?:\/\//.test(url)) throw new StepFailure(400, "migrate_d1.bad_request", "import needs the export's url");
	const checkIntegers = body.checkIntegers === true;
	const status = await actor(fetcher, binding, "status", {});
	if (status.state !== "importing") throw new StepFailure(409, "migrate_d1.not_started", "No copy has started for this database. Run begin first.");
	if (typeof body.export === "string" && body.export !== status.export) {
		throw new StepFailure(409, "migrate_d1.export_changed", "Orange's copy comes from another export than this URL's. Run begin with this export first.");
	}
	let offset = Number(status.offset);
	let size = status.size === null ? null : Number(status.size);
	let statements = Number(status.statements);
	if (size !== null && offset >= size) return { done: true, offset, size, statements };

	const started = Date.now();
	const abort = new AbortController();
	let response: Awaited<ReturnType<typeof fetch>>;
	try {
		response = await fetch(url, { headers: offset > 0 ? { range: `bytes=${offset}-` } : {}, signal: abort.signal });
	} catch (error: unknown) {
		throw new StepFailure(424, "migrate_d1.export_unreachable", `Orange couldn't read the export: ${error instanceof Error ? error.message : String(error)}`);
	}
	// R2 answers 403 to a signed URL past its hour, and 404 once the file is gone.
	if (response.status === 400 || response.status === 403 || response.status === 404 || response.status === 410) {
		await response.body?.cancel();
		throw new StepFailure(410, "migrate_d1.export_expired", `The export's URL no longer works (HTTP ${response.status}). Export again.`);
	}
	if (!response.ok || response.body === null) {
		await response.body?.cancel();
		throw new StepFailure(424, "migrate_d1.export_unreachable", `Reading the export answered HTTP ${response.status}.`);
	}
	let skip = 0;
	let total: number;
	if (response.status === 206) {
		const range = contentRange(response.headers.get("content-range"));
		if (range === undefined || range.start !== offset) throw new StepFailure(424, "migrate_d1.export_unreachable", "The export's server answered another byte range than Orange asked for.");
		total = range.total;
	} else {
		// A server that ignores Range sends the whole file, so the bytes Orange holds are skipped.
		total = Number(response.headers.get("content-length") ?? Number.NaN);
		skip = offset;
	}
	if (!Number.isFinite(total)) throw new StepFailure(424, "migrate_d1.export_unreachable", "The export's server did not say how large the export is.");
	if (size !== null && total !== size) {
		await response.body.cancel();
		throw new StepFailure(409, "migrate_d1.export_changed", `This export is ${total} bytes, and the copy Orange holds came from one of ${size} bytes.`);
	}
	size = total;

	let buffer = Buffer.alloc(0);
	// The byte offset of buffer[0] in the export.
	let bufferStart = offset;
	let pending: ImportStatement[] = [];
	let pendingBytes = 0;
	let pendingTo = offset;
	let frozen = false;
	const flush = async (): Promise<void> => {
		if (pendingTo <= offset) return;
		const applied = await actor(fetcher, binding, "apply", { from: offset, frozen, size, statements: pending, to: pendingTo });
		statements = Number(applied.statements ?? statements);
		offset = pendingTo;
		pending = [];
		pendingBytes = 0;
	};
	const reader = response.body.getReader();
	try {
		for (;;) {
			let read: Awaited<ReturnType<typeof reader.read>>;
			try {
				read = await reader.read();
			} catch (error: unknown) {
				// The connection broke. What is committed stays, and the next step reads from there.
				await flush();
				return { done: false, interrupted: error instanceof Error ? error.message : String(error), ms: Date.now() - started, offset, size, statements };
			}
			const { done, value } = read;
			if (value !== undefined) {
				let chunk = Buffer.from(value.buffer, value.byteOffset, value.byteLength);
				if (skip > 0) {
					const skipped = Math.min(skip, chunk.length);
					skip -= skipped;
					chunk = chunk.subarray(skipped);
				}
				buffer = buffer.length === 0 ? chunk : Buffer.concat([buffer, chunk]);
			}
			const split = splitDump(buffer, done);
			for (const statement of split.statements) {
				let action;
				try {
					action = dumpAction(statement.sql, checkIntegers);
				} catch (error: unknown) {
					if (error instanceof DumpError) throw new StepFailure(422, "migrate_d1.export_unsupported", error.message);
					throw error;
				}
				if (isFrozenStateRow(statement.sql)) frozen = true;
				const end = bufferStart + statement.end;
				if (action.kind === "skip") {
					pendingTo = end;
					continue;
				}
				// An index can take minutes on a large table, so it gets a commit of its own.
				if (action.kind === "index") await flush();
				pending.push({ kind: action.kind, sql: action.sql });
				pendingBytes += action.sql.length;
				pendingTo = end;
				if (action.kind === "index" || pendingBytes >= commitBytes) await flush();
			}
			buffer = buffer.subarray(split.rest);
			bufferStart += split.rest;
			// Whitespace and comments after the last statement are part of what is done.
			if (done) pendingTo = Math.max(pendingTo, bufferStart);
			if (done) {
				await flush();
				break;
			}
			if (Date.now() - started > importBudgetMs) {
				await flush();
				break;
			}
		}
	} finally {
		abort.abort();
		reader.releaseLock();
	}
	return { done: offset >= size, ms: Date.now() - started, offset, size, statements };
}

// The import step that runs for each binding. A step that the CLI sends again, such as after a lost
// answer, waits for the one before it, so two steps never read and apply the same bytes at once.
const importSteps = new Map<string, Promise<unknown>>();

function oneImportAtATime(binding: string, run: () => Promise<unknown>): Promise<unknown> {
	const step = (importSteps.get(binding) ?? Promise.resolve()).catch(() => undefined).then(run);
	importSteps.set(binding, step);
	void step.catch(() => undefined).finally(() => {
		if (importSteps.get(binding) === step) importSteps.delete(binding);
	});
	return step;
}

async function answer(request: Request, binding: string, step: string, bindings: Readonly<Record<string, unknown>>): Promise<Response> {
	const database = bindings[binding];
	const fetcher = d1DatabaseFetcher(database);
	if (!(database instanceof D1Database) || fetcher === undefined) {
		return failure(404, "migrate_d1.unknown_binding", `no D1 binding named "${binding}"`);
	}
	const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;
	if (step === "query") {
		try {
			const result = await runForwarded(database, String(body.mode ?? "batch"), (body.statements as ForwardedStatement[] | undefined) ?? []);
			return Response.json({ result });
		} catch (error: unknown) {
			return failure(400, "migrate_d1.query_failed", error instanceof Error ? error.message : String(error));
		}
	}
	try {
		if (step === "import") return Response.json(await oneImportAtATime(binding, () => importStep(fetcher, binding, body)));
		if (!actorSteps.has(step)) return failure(404, "migrate_d1.unknown_step", `no D1 migration step named ${step}`);
		return Response.json(await actor(fetcher, binding, step, body));
	} catch (error: unknown) {
		if (error instanceof StepFailure) {
			return Response.json(
				{ error: { code: error.code, message: error.message, ...(error.code === "migrate_d1.storage_busy" ? { retryAfterMs: 2_000 } : {}) } },
				{ status: error.status },
			);
		}
		// Such as the D1 actor stopping with Orange. Every step can run again from what is durable.
		return failure(503, "migrate_d1.unavailable", `The D1 database did not answer: ${error instanceof Error ? error.message : String(error)}`);
	}
}

export function d1MigrationRoute(
	request: Request,
	bindings: Readonly<Record<string, unknown>>,
): Promise<Response> | undefined {
	if (request.method !== "POST" || !request.url.includes(routePrefix)) return undefined;
	const { pathname } = new URL(request.url);
	if (!pathname.startsWith(routePrefix)) return undefined;
	const settings = runtimeSettings();
	const token = settings.WORKER_MIGRATOR_TOKEN ?? "";
	// The route exists only during a migration. Otherwise the Worker gets the request.
	if ((settings[workerUrlSetting] ?? "") === "" || token === "") return undefined;
	if (!tokenMatches(request, token)) {
		return Promise.resolve(failure(401, "migrate_d1.unauthorized", "missing or wrong migrator token"));
	}
	const [binding = "", step = "", ...rest] = pathname.slice(routePrefix.length).split("/").map(decodeURIComponent);
	if (rest.length > 0) return Promise.resolve(failure(404, "migrate_d1.unknown_step", `no D1 migration route ${pathname}`));
	return answer(request, binding, step, bindings);
}
