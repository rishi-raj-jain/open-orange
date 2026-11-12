import { Buffer } from "node:buffer";
import { timingSafeEqual } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";

import { createClient, MigrationDirtyError, MigratorError } from "@rivet-dev/durable-object-migrator/client";
import { parse as parseKvValue } from "devalue";

import { Request, Response } from "../../globals/http.js";
import { d1MigrationRoute } from "../d1/migration-route.js";
import type { RivetSqliteDatabase, RivetSynchronousSqliteExecutor } from "../../internal/rivetkit.js";
import { runtimeSettings } from "../../internal/runtime-settings.js";
import { DurableObjectAlarmStore } from "./alarm-storage.js";
import { isForeignDurableObjectId, type DurableObjectId } from "./id.js";
import { readDurableObjectMetadata, writeDurableObjectMetadata } from "./metadata.js";
import { workerUrlSetting } from "./migration-mode.js";
import { type DurableObjectNamespace, durableObjectNamespaceClassName, resolveDurableObjectStub } from "./namespace.js";
import { DurableObjectKvStore } from "./sync-kv.js";

// Lazy migration from Cloudflare, on only while `ORANGE_MIGRATE_WORKER_URL` is set. Each object
// copies itself from the prepared Worker before its first construction, so the user's constructor
// never sees an empty database and `CREATE TABLE IF NOT EXISTS` cannot collide with the import.
// https://github.com/rivet-dev/durable-object-migrator/blob/816c28b/docs/guide.md#what-an-export-contains

const tokenSetting = "WORKER_MIGRATOR_TOKEN";
const importStarted = "started";
const importDone = "done";
const kvTable = "__do_kv";
const metaTable = "__do_meta";
const kvBatch = 200;
const maxDirtyAttempts = 10;
const maxDirtyDelayMs = 5_000;
const pageTransactionTimeoutMs = 60_000;

/** An action that does nothing. Calling it starts the object, which runs the import. */
export const durableObjectWakeAction = "__openorange_wake";

/**
 * What the wake action returns. `copied` is false when the object already had its copy, so a
 * backfill can tell moved objects from objects that moved earlier. `error` is why the copy failed.
 */
export type DurableObjectWakeResult = { copied: boolean; ok: true } | { error: string; internal: boolean; ok: false };

/**
 * True for a copy that failed in Orange itself, such as SQL from the export that Orange's SQLite
 * cannot run. A refusal or an outage of Cloudflare, or of the network, is not internal.
 */
export function isInternalImportFailure(error: unknown): boolean {
	return error instanceof Error && "internal" in error && error.internal === true;
}

// Undici's fetch rejects a request that never got a response with this TypeError.
function isNetworkFailure(error: unknown): boolean {
	return error instanceof TypeError && error.message === "fetch failed";
}

function isWakeResult(value: unknown): value is DurableObjectWakeResult {
	return typeof value === "object" && value !== null && "ok" in value && typeof value.ok === "boolean";
}
const wakeRoute = /^\/__migrate\/([^/]+)\/wake$/;

interface CloudflareImportSource {
	readonly token: string;
	readonly workerUrl: string;
}

function importSource(): CloudflareImportSource | undefined {
	const settings = runtimeSettings();
	const workerUrl = settings[workerUrlSetting] ?? "";
	if (workerUrl === "") return undefined;
	const token = settings[tokenSetting] ?? "";
	if (token === "") {
		throw new Error(`${workerUrlSetting} is set, so ${tokenSetting} must be set too. Use the value on the Cloudflare Worker.`);
	}
	return { token, workerUrl };
}

function bindingOfClass(bindings: Readonly<Record<string, unknown>>, className: string): string | undefined {
	return Object.keys(bindings).find((name) => durableObjectNamespaceClassName(bindings[name]) === className);
}

// Every table, view, index, and trigger that deleteAll() would remove, including `_cf_KV` and
// `_cf_ALARM`. A table with no rows counts: it means user code has run on this object.
function hasUserStorage(database: RivetSynchronousSqliteExecutor): boolean {
	const { rows } = database.executeSync(
		`SELECT 1 FROM sqlite_master WHERE name NOT LIKE 'sqlite\\_%' ESCAPE '\\' AND name NOT LIKE '\\_rivet\\_%' ESCAPE '\\' LIMIT 1`,
	);
	return rows.length > 0;
}

function resetUserStorage(database: RivetSynchronousSqliteExecutor): void {
	new DurableObjectKvStore(() => database).deleteAll();
}

// The export is plain SQL, with KV values in `__do_kv` and the alarm time in `__do_meta`. Orange
// keeps those in `_cf_KV` and `_cf_ALARM`, so the object reads them through its normal storage API.
function moveExportedTablesIntoStorage(database: RivetSynchronousSqliteExecutor): void {
	const kv = new DurableObjectKvStore(() => database);
	for (let offset = 0; ; offset += kvBatch) {
		const { rows } = database.executeSync(`SELECT key, value FROM "${kvTable}" ORDER BY key LIMIT ${kvBatch} OFFSET ${offset}`);
		for (const [key, value] of rows) kv.put(String(key), parseKvValue(String(value)));
		if (rows.length < kvBatch) break;
	}
	const alarm = database.executeSync(`SELECT value FROM "${metaTable}" WHERE key = 'alarm'`).rows[0]?.[0];
	if (alarm !== undefined && alarm !== null) new DurableObjectAlarmStore(() => database).set(Number(alarm));
	database.executeSync(`DROP TABLE "${kvTable}"`);
	database.executeSync(`DROP TABLE "${metaTable}"`);
}

async function copyObject(
	database: RivetSqliteDatabase,
	client: ReturnType<typeof createClient>,
	binding: string,
	id: string,
): Promise<void> {
	resetUserStorage(database);
	// A child row can arrive before its parent. The setting cannot change inside a transaction.
	const foreignKeys = database.executeSync("PRAGMA foreign_keys").rows[0]?.[0];
	database.executeSync("PRAGMA foreign_keys = OFF");
	try {
		for await (const page of client.exportObject({ binding, id })) {
			const transaction = database.beginTransactionSync(pageTransactionTimeoutMs);
			try {
				for (const statement of page.statements) {
					if (!statement.startsWith("PRAGMA foreign_keys")) transaction.executeSync(statement);
				}
				transaction.commitSync();
			} catch (error: unknown) {
				transaction.rollbackSync();
				throw error;
			}
			// Deferred commits return before they are durable, so wait to keep memory bounded.
			await database.whenDurable(database.commitTicket());
		}
		const transaction = database.beginTransactionSync(pageTransactionTimeoutMs);
		try {
			moveExportedTablesIntoStorage(transaction);
			// In `_rivet_` metadata, so deleteAll() cannot make the object import itself again.
			writeDurableObjectMetadata(transaction, "cloudflareImport", importDone);
			transaction.commitSync();
		} catch (error: unknown) {
			transaction.rollbackSync();
			throw error;
		}
		await database.whenDurable(database.commitTicket());
	} finally {
		database.executeSync(`PRAGMA foreign_keys = ${foreignKeys === 0 ? "OFF" : "ON"}`);
	}
}

/** True when this object has a copy to fetch. Reads only its own metadata, so it is cheap. */
export function cloudflareImportIsPending(
	database: RivetSqliteDatabase | undefined,
	object: { readonly className: string; readonly id?: DurableObjectId | string | undefined },
	bindings: Readonly<Record<string, unknown>>,
): boolean {
	if (database === undefined || object.id === undefined || typeof object.id === "string") return false;
	if (importSource() === undefined) return false;
	if (readDurableObjectMetadata(database, "cloudflareImport") === importDone) return false;
	// Orange's own classes and classes without a binding are not on the prepared Worker's route.
	return bindingOfClass(bindings, object.className) !== undefined;
}

/** True when this object's copy finished. */
export function cloudflareImportIsDone(database: RivetSqliteDatabase | undefined): boolean {
	return database !== undefined && readDurableObjectMetadata(database, "cloudflareImport") === importDone;
}

/**
 * True when a copy began and did not finish. The object holds only part of its data, and with the
 * migration off nothing would finish the copy, so it must not serve. One read per start.
 */
export function cloudflareImportIsUnfinished(database: RivetSqliteDatabase | undefined): boolean {
	return database !== undefined && readDurableObjectMetadata(database, "cloudflareImport") === importStarted;
}

export function unfinishedCloudflareImportError(object: { readonly className: string; readonly id?: DurableObjectId | string | undefined }): Error {
	const id = typeof object.id === "string" ? object.id : (object.id?.name ?? object.id?.toString() ?? "unknown");
	return new Error(
		`${object.className} ${id} has an unfinished copy from Cloudflare, so Orange will not serve its partial data. Set ${workerUrlSetting} again to finish the copy.`,
	);
}

/**
 * Copies one object from Cloudflare. A failure fails the calls that wait for the object, so it never
 * serves empty data. The next call tries again from the beginning.
 */
export async function importDurableObjectFromCloudflare(
	database: RivetSqliteDatabase | undefined,
	object: { readonly className: string; readonly id?: DurableObjectId | string | undefined },
	bindings: Readonly<Record<string, unknown>>,
): Promise<void> {
	const source = importSource();
	const binding = bindingOfClass(bindings, object.className);
	if (database === undefined || source === undefined || binding === undefined) return;
	if (object.id === undefined || typeof object.id === "string") return;
	// The slot builds the object again after a hibernation or a failed constructor. Its copy is there.
	if (readDurableObjectMetadata(database, "cloudflareImport") === importDone) return;
	const { id } = object;
	if (id.jurisdiction !== undefined) {
		throw new Error(`orange migrate does not support the ${id.jurisdiction} jurisdiction of ${object.className} objects.`);
	}
	// An object that Orange created has no copy on Cloudflare, so a lookup there would fail.
	if (id.name === undefined && !isForeignDurableObjectId(id)) {
		writeDurableObjectMetadata(database, "cloudflareImport", importDone);
		await database.whenDurable(database.commitTicket());
		return;
	}
	// The only data a copy may replace is its own earlier attempt. Anything else belongs to the user:
	// this object ran on Orange before the migration was turned on.
	if (readDurableObjectMetadata(database, "cloudflareImport") !== importStarted) {
		if (hasUserStorage(database)) {
			throw new Error(
				`${object.className} ${id.name ?? id.toString()} has data on Orange that did not come from this migration, so Orange will not replace it with the Cloudflare copy. To keep the data on Orange, remove ${workerUrlSetting}.`,
			);
		}
		writeDurableObjectMetadata(database, "cloudflareImport", importStarted);
		await database.whenDurable(database.commitTicket());
	}
	const client = createClient(source);
	const label = `${object.className} ${id.name ?? id.toString()}`;
	try {
		const cloudflareId = id.name === undefined ? id.toString() : (await client.resolve(binding, { name: id.name })).id;
		for (let attempt = 1; ; attempt += 1) {
			try {
				await copyObject(database, client, binding, cloudflareId);
				return;
			} catch (error: unknown) {
				// A client with stale DNS wrote to the old copy during the export. The whole copy is void.
				if (!(error instanceof MigrationDirtyError) || attempt === maxDirtyAttempts) throw error;
				await delay(Math.min(250 * 2 ** (attempt - 1), maxDirtyDelayMs));
			}
		}
	} catch (error: unknown) {
		throw Object.assign(new Error(`Couldn't import ${label} from Cloudflare: ${importFailureReason(error, id.name !== undefined)}`, { cause: error }), {
			internal: !(error instanceof MigratorError) && !isNetworkFailure(error),
		});
	}
}

// The export goes through the Worker to the object. After the wrapped deploy, an object that kept
// a WebSocket open still runs the code from before it, which has no export route, so it answers
// like the app. When the Worker answered the name lookup, the URL is right, and only that is left.
function importFailureReason(error: unknown, workerAnswered: boolean): string {
	const message = error instanceof Error ? error.message : String(error);
	if (!(error instanceof MigratorError) || error.code !== "migrator.not_a_migrator") return message;
	const status = error.status === undefined ? "" : ` (HTTP ${error.status})`;
	const oldCode =
		`the object did not answer as a migrator${status}. It may still run code from before the wrapped Worker was deployed: ` +
		"an object with open WebSockets keeps its old code until those connections close. Try again after its old connections close.";
	return workerAnswered
		? `The Worker on Cloudflare answered, but ${oldCode}`
		: `${oldCode} Also check that ${workerUrlSetting} reaches the wrapped Worker on Cloudflare, such as its workers.dev URL.`;
}

function tokenMatches(request: Request, token: string): boolean {
	const received = Buffer.from(request.headers.get("authorization") ?? "");
	const expected = Buffer.from(`Bearer ${token}`);
	return received.byteLength === expected.byteLength && timingSafeEqual(received, expected);
}

function failure(status: number, code: string, message: string): Response {
	return Response.json({ error: { code, message } }, { status });
}

async function wakeObject(
	request: Request,
	binding: string,
	source: CloudflareImportSource,
	bindings: Readonly<Record<string, unknown>>,
): Promise<Response> {
	if (!tokenMatches(request, source.token)) {
		return failure(401, "migrate.unauthorized", "missing or wrong migrator token");
	}
	const namespace = bindings[binding] as DurableObjectNamespace | undefined;
	if (durableObjectNamespaceClassName(namespace) === undefined || namespace === undefined) {
		return failure(404, "migrate.unknown_binding", `no Durable Object binding named "${binding}"`);
	}
	const { searchParams } = new URL(request.url);
	const name = searchParams.get("name");
	const idParameter = searchParams.get("id");
	let id: DurableObjectId;
	try {
		if (name !== null) id = namespace.idFromName(name);
		else if (idParameter !== null) id = namespace.idFromString(idParameter);
		else return failure(400, "migrate.bad_request", "missing ?id= or ?name=");
	} catch (error: unknown) {
		return failure(400, "migrate.bad_request", error instanceof Error ? error.message : String(error));
	}
	try {
		const result: unknown = await resolveDurableObjectStub(namespace.get(id)).action({ args: [], name: durableObjectWakeAction });
		if (isWakeResult(result) && !result.ok) return failure(502, result.internal ? "migrate.internal" : "migrate.import_failed", result.error);
		return Response.json({ copied: isWakeResult(result) && result.ok ? result.copied : true, ok: true });
	} catch (error: unknown) {
		return failure(502, "migrate.import_failed", error instanceof Error ? error.message : String(error));
	}
}

/**
 * `POST /__migrate/<BINDING>/wake?name=|id=` starts one object, so `orange migrate backfill` can copy
 * objects that get no traffic. The route exists only during a migration. Otherwise the Worker gets it.
 */
export function cloudflareMigrationRoute(
	request: Request,
	bindings: Readonly<Record<string, unknown>>,
): Promise<Response> | undefined {
	const d1 = d1MigrationRoute(request, bindings);
	if (d1 !== undefined) return d1;
	// Every request of every Worker comes through here, so parse the URL only for this path.
	if (request.method !== "POST" || !request.url.includes("/__migrate/")) return undefined;
	const match = wakeRoute.exec(new URL(request.url).pathname);
	if (match === null) return undefined;
	const source = importSource();
	if (source === undefined) return undefined;
	return wakeObject(request, decodeURIComponent(match[1] ?? ""), source, bindings);
}
