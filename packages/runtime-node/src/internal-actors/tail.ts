import { AsyncResource } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";

import {
	DurableJsonStream,
	durableStreamMaxAppendBytes,
	type DurableStreamProducer,
} from "../internal/durable-stream.js";
import {
	createRivetInternalActorDefinition,
	createRivetRawDatabaseProvider,
	type RivetActorClient,
	type RivetInternalActorDefinition,
	type RivetRawDatabase,
} from "../internal/rivetkit.js";
import type { TraceRecord } from "../internal/tail-trace.js";

// Tail Workers on Rivet Durable Streams. Producers append each event's trace record, after the
// event, to the consumer's current segment stream `tail/<consumer>/<n>`, where n numbers the
// segment's time window. One `openorange:tail` actor per consumer, hosted by the consumer Worker,
// reads the segments in order from a saved offset and calls tail() with each batch. The offset
// moves only after tail() succeeds, so delivery is at least once. Durable Streams 0.1.7 cannot
// drop the start of a stream, so retention works per segment: the consumer deletes a segment once
// it has moved past it, and each segment expires on its own `retention` after its window ends.
export const tailActorName = "openorange:tail";

export interface TailSegments {
	readonly lengthMs: number;
	readonly retentionMs: number;
}

const maxRetainedSegments = 2_048;
// Segments that one probe round checks at once.
const probeBatch = 32;

const defaultSegments: TailSegments = { lengthMs: 60 * 60 * 1_000, retentionMs: 7 * 24 * 60 * 60 * 1_000 };

function positiveSeconds(value: string | undefined, fallbackMs: number): number {
	const seconds = Number(value);
	return value !== undefined && Number.isFinite(seconds) && seconds > 0 ? seconds * 1_000 : fallbackMs;
}

/**
 * Segment settings from the host environment, which every runtime of a deployment shares, so
 * producers and consumers agree: ORANGE_TAIL_SEGMENT_SECONDS (default 1 hour) and
 * ORANGE_TAIL_RETENTION_SECONDS (default 7 days).
 */
export function tailSegmentsFromEnvironment(environment: NodeJS.ProcessEnv): TailSegments {
	const retentionMs = positiveSeconds(environment.ORANGE_TAIL_RETENTION_SECONDS, defaultSegments.retentionMs);
	const lengthMs = positiveSeconds(environment.ORANGE_TAIL_SEGMENT_SECONDS, defaultSegments.lengthMs);
	// A consumer that starts probes every segment that retention can keep, so their count is capped.
	return { lengthMs: Math.max(lengthMs, Math.ceil(retentionMs / maxRetainedSegments)), retentionMs };
}


function segmentAt(segments: TailSegments, timeMs: number): number {
	return Math.floor(timeMs / segments.lengthMs);
}

function segmentEnd(segments: TailSegments, segment: number): number {
	return (segment + 1) * segments.lengthMs;
}

function segmentExpiry(segments: TailSegments, segment: number): Date {
	return new Date(segmentEnd(segments, segment) + segments.retentionMs);
}

// How long after a segment's window the consumer still reads it, for appends that started in the
// window and land late, and for clocks of other nodes that run behind.
function segmentGraceMs(segments: TailSegments): number {
	return Math.min(60_000, segments.lengthMs);
}

function segmentPath(consumer: string, segment: number): string {
	return `tail/${consumer}/${segment}`;
}

// Records that wait for an append, per consumer, before the oldest are dropped.
const maxBufferedRecords = 10_000;
// Room under the append body limit for the array's brackets and commas.
const appendBudgetBytes = durableStreamMaxAppendBytes - 16 * 1024;
// Durable Streams 0.1.7 answers an empty long-poll after 2 s.
// https://github.com/rivet-dev/durable-streams/blob/09fcd92/src/protocol.rs#L12
const longPollMs = 2_000;
// The pause between reads of a segment that ends within one long-poll.
const shortReadMs = 100;
// A batch whose tail() calls keep failing is dropped after this many calls.
const maxTailAttempts = 10;

// The first failure of an outage says what Tail Workers need, because on a cluster the usual cause is
// a missing Services deployment.
function unreachable(consumer: string, error: unknown): Error {
	return new Error(
		`Tail events for ${consumer} wait: Durable Streams is unreachable. Tail Workers need Rivet Services in the envoy pool \`services\`; orange dev starts it, and a cluster needs its own Services deployment.`,
		{ cause: error },
	);
}

function backoffMs(attempt: number, firstMs: number, maxMs: number): number {
	return Math.min(maxMs, firstMs * 2 ** Math.max(0, attempt - 1));
}

async function sleep(ms: number, signal?: AbortSignal): Promise<void> {
	try {
		await delay(ms, undefined, signal === undefined ? undefined : { signal });
	} catch {
		// Aborted: the caller checks its signal.
	}
}

export interface TailAppenderOptions {
	consumers: readonly string[];
	reportError(error: unknown): void;
	segments: TailSegments;
	// The client of the `services` pool. It may start the Rivet registry on first use.
	streams(): Promise<RivetActorClient>;
	workerName: string | null;
}

export interface TailAppender {
	// Settles once the records delivered so far are appended, or `timeoutMs` passes.
	close(timeoutMs: number): Promise<void>;
	deliver(record: TraceRecord): void;
	// Creates the consumers' current segments with the started registry's client, so the first
	// event's append does not wait for a creation.
	prepare(client: RivetActorClient): Promise<void>;
}

interface ConsumerBuffer {
	readonly consumer: string;
	// The newest segment that an append went to. Appends never go back to an older one.
	segment: number;
	pending: TraceRecord[];
	pump: Promise<void> | undefined;
}

/**
 * Appends this Worker's trace records to its consumers' streams. deliver() only buffers, so the
 * event that made the record waits for no I/O. One append per consumer is in flight; the next takes
 * every record that arrived meanwhile.
 */
export function createTailAppender(options: TailAppenderOptions): TailAppender {
	const { segments } = options;
	// One producer identity per runtime: a stream drops a retried append with a seq it has.
	const producerId = `${options.workerName ?? "worker"}/${randomUUID()}`;
	const producers = new Map<string, DurableStreamProducer>();
	const buffers = new Map<string, ConsumerBuffer>(
		options.consumers.map((consumer) => [consumer, { consumer, pending: [], pump: undefined, segment: 0 }]),
	);
	let streamClient: Promise<RivetActorClient> | undefined;
	const streams = new Map<string, DurableJsonStream>();
	const stream = async (path: string): Promise<DurableJsonStream> => {
		const client = await (streamClient ??= options.streams().catch((error: unknown) => {
			streamClient = undefined;
			throw error;
		}));
		let handle = streams.get(path);
		if (handle === undefined) {
			handle = new DurableJsonStream(client, path);
			streams.set(path, handle);
		}
		return handle;
	};

	const appendToCurrentSegment = async (buffer: ConsumerBuffer, batch: readonly string[]): Promise<void> => {
		buffer.segment = Math.max(buffer.segment, segmentAt(segments, Date.now()));
		const segment = buffer.segment;
		const target = await stream(segmentPath(buffer.consumer, segment));
		let producer = producers.get(target.path);
		if (producer === undefined) {
			producer = { id: producerId, seq: 0 };
			producers.set(target.path, producer);
		}
		if ((await target.append(batch, producer)) === undefined) {
			await target.create(segmentExpiry(segments, segment));
			if ((await target.append(batch, producer)) === undefined) {
				throw new Error(`Durable Streams stream ${target.path} disappeared after its creation`);
			}
		}
		producer.seq += 1;
		// Seqs of older segments are no longer needed.
		for (const path of producers.keys()) {
			if (path !== target.path && path.startsWith(`tail/${buffer.consumer}/`)) producers.delete(path);
		}
	};

	const pumpBuffer = async (buffer: ConsumerBuffer): Promise<void> => {
		while (buffer.pending.length > 0) {
			// Serialized here rather than in deliver(), off the event's path.
			const batch: string[] = [];
			let bytes = 0;
			while (buffer.pending.length > 0) {
				const encoded = JSON.stringify(buffer.pending[0]);
				const size = Buffer.byteLength(encoded) + 1;
				if (batch.length > 0 && bytes + size > appendBudgetBytes) break;
				buffer.pending.shift();
				if (size > appendBudgetBytes) {
					options.reportError(
						new Error(`Dropped a tail event of ${size} bytes for ${buffer.consumer}: it exceeds the append limit`),
					);
					continue;
				}
				batch.push(encoded);
				bytes += size;
			}
			if (batch.length === 0) continue;
			// A retry to the same segment sends the same records with the same seq, so the stream
			// can drop it when the first attempt landed and only its response was lost.
			for (let failures = 1; ; failures += 1) {
				try {
					await appendToCurrentSegment(buffer, batch);
					break;
				} catch (error: unknown) {
					// One report per outage, not one per retry.
					if (failures === 1) options.reportError(unreachable(buffer.consumer, error));
					await sleep(backoffMs(failures, 100, 10_000));
				}
			}
		}
	};
	// The pump outlives the event that started it, so it must not carry that event's context, which
	// would trace the pump's own work as part of the event.
	const startPump = AsyncResource.bind((buffer: ConsumerBuffer): void => {
		buffer.pump ??= pumpBuffer(buffer).finally(() => {
			buffer.pump = undefined;
			if (buffer.pending.length > 0) startPump(buffer);
		});
	});

	return {
		async close(timeoutMs): Promise<void> {
			const pumps = [...buffers.values()].flatMap((buffer) => (buffer.pump === undefined ? [] : [buffer.pump]));
			if (pumps.length === 0) return;
			await Promise.race([Promise.all(pumps), delay(timeoutMs)]);
		},
		deliver(record): void {
			for (const buffer of buffers.values()) {
				buffer.pending.push(record);
				if (buffer.pending.length > maxBufferedRecords) {
					const dropped = buffer.pending.length - maxBufferedRecords;
					buffer.pending.splice(0, dropped);
					options.reportError(
						new Error(`Dropped ${dropped} tail event(s) for ${buffer.consumer}: the append buffer is full`),
					);
				}
				startPump(buffer);
			}
		},
		async prepare(client): Promise<void> {
			streamClient ??= Promise.resolve(client);
			const segment = segmentAt(segments, Date.now());
			await Promise.all(
				options.consumers.map(async (consumer) =>
					await (await stream(segmentPath(consumer, segment))).create(segmentExpiry(segments, segment)),
				),
			);
		},
	};
}

const schema = [
	"CREATE TABLE IF NOT EXISTS tail_cursor (id INTEGER PRIMARY KEY CHECK (id = 0), segment INTEGER NOT NULL, offset TEXT NOT NULL, failures INTEGER NOT NULL, trailing_segment INTEGER, trailing_offset TEXT)",
];

interface Position {
	offset: string;
	segment: number;
}

interface Cursor extends Position {
	failures: number;
	// The segment the cursor left, read once more when its grace ends, then deleted.
	trailing: Position | null;
}

async function readCursor(database: RivetRawDatabase): Promise<Cursor | undefined> {
	const [row] = await database.execute(
		"SELECT segment, offset, failures, trailing_segment, trailing_offset FROM tail_cursor WHERE id = 0",
	);
	if (row === undefined) return undefined;
	return {
		failures: Number(row.failures),
		offset: String(row.offset),
		segment: Number(row.segment),
		trailing:
			row.trailing_segment === null || row.trailing_segment === undefined
				? null
				: { offset: String(row.trailing_offset), segment: Number(row.trailing_segment) },
	};
}

// The SQLite write is durable when it returns, so a crash after it never redelivers the batch.
async function writeCursor(database: RivetRawDatabase, cursor: Cursor): Promise<void> {
	await database.execute(
		"INSERT INTO tail_cursor (id, segment, offset, failures, trailing_segment, trailing_offset) VALUES (0, ?, ?, ?, ?, ?) ON CONFLICT (id) DO UPDATE SET segment = excluded.segment, offset = excluded.offset, failures = excluded.failures, trailing_segment = excluded.trailing_segment, trailing_offset = excluded.trailing_offset",
		cursor.segment,
		cursor.offset,
		cursor.failures,
		cursor.trailing?.segment ?? null,
		cursor.trailing?.offset ?? null,
	);
}

export interface TailActorOptions {
	// Calls the Worker's tail() handler. It rejects when the handler throws.
	dispatch(records: readonly TraceRecord[]): Promise<void>;
	reportError(error: unknown): void;
	segments: TailSegments;
	// The client of the `services` pool.
	streams(): RivetActorClient;
}

/** The actor that delivers one consumer's segments to its tail() handler, keyed by the consumer name. */
export function createTailActorDefinition(options: TailActorOptions): RivetInternalActorDefinition {
	const { segments } = options;
	// Settles once the consumer's loop in this process has found the segment that it reads first.
	const positioned = new Map<string, PromiseWithResolvers<void>>();
	const positionOf = (consumer: string): PromiseWithResolvers<void> => {
		let position = positioned.get(consumer);
		if (position === undefined) {
			position = Promise.withResolvers<void>();
			positioned.set(consumer, position);
		}
		return position;
	};
	return createRivetInternalActorDefinition<Record<string, never>>({
		actions: {
			// Starts the delivery loop of a sleeping actor, and returns once the loop reads, so an event
			// right after the Worker starts does not wait for the probe of older segments.
			wake: async (context): Promise<void> => {
				const consumer = context.key[0];
				if (consumer === undefined) return;
				await Promise.race([positionOf(consumer).promise, delay(10_000)]);
			},
		},
		db: createRivetRawDatabaseProvider(async (database) => {
			for (const statement of schema) await database.execute(statement);
		}),
		options: { name: "Tail Workers (Orange)" },
		async run(context): Promise<void> {
			const consumer = context.key[0];
			if (consumer === undefined) return;
			const signal = context.abortSignal;
			const client = options.streams();
			const stream = (segment: number): DurableJsonStream =>
				new DurableJsonStream(client, segmentPath(consumer, segment));
			// A consumer that never ran starts at the oldest segment that retention can keep.
			let cursor: Cursor = (await readCursor(context.db)) ?? {
				failures: 0,
				offset: "-1",
				segment: segmentAt(segments, Date.now() - segments.retentionMs),
				trailing: null,
			};
			let createdSegment: number | undefined;
			let readFailures = 0;
			const position = positionOf(consumer);

			// Moves past the cursor's segment to the next segment that exists, or the current one. A
			// segment it has read becomes the trailing segment, which the loop reads once more after its
			// grace, for appends that land late, and then deletes; a crash before that leaves it to its
			// expiry. Probes use exists(), because a call on a missing stream creates its actor.
			const advance = async (current: number, trailing: Position | null): Promise<void> => {
				const done = cursor.segment;
				let next = current;
				for (let from = done + 1; from < current; from += probeBatch) {
					const candidates = Array.from({ length: Math.min(probeBatch, current - from) }, (_, index) => from + index);
					const found = await Promise.all(candidates.map(async (segment) => await stream(segment).exists()));
					const index = found.indexOf(true);
					if (index !== -1) {
						next = from + index;
						break;
					}
				}
				cursor = { failures: 0, offset: "-1", segment: next, trailing: trailing ?? cursor.trailing };
				await writeCursor(context.db, cursor);
			};

			// Calls tail() with one read's records. Returns whether the read is done with: delivered, or
			// dropped after too many failed calls. Otherwise it backs off, and the loop reads it again.
			const deliver = async (items: readonly unknown[]): Promise<boolean> => {
				try {
					// SAFETY: Only Orange producers append to `tail/<consumer>/<n>`, and they append
					// TraceRecord values.
					await options.dispatch(items as TraceRecord[]);
					return true;
				} catch (error: unknown) {
					options.reportError(error);
					const failures = cursor.failures + 1;
					if (failures < maxTailAttempts) {
						cursor = { ...cursor, failures };
						await writeCursor(context.db, cursor);
						await sleep(backoffMs(failures, 1_000, 60_000), signal);
						return false;
					}
					options.reportError(
						new Error(`Dropped ${items.length} tail event(s) for ${consumer} after ${failures} failed tail() calls`),
					);
					return true;
				}
			};

			try {
				const current = segmentAt(segments, Date.now());
				if (cursor.segment < current && cursor.offset === "-1" && !(await stream(cursor.segment).exists())) {
					await advance(current, null);
				}
				if (cursor.segment >= current) {
					await stream(cursor.segment).create(segmentExpiry(segments, cursor.segment));
					createdSegment = cursor.segment;
				}
			} catch (error: unknown) {
				// The loop retries.
				if (!signal.aborted) options.reportError(unreachable(consumer, error));
			} finally {
				position.resolve();
			}

			while (!signal.aborted) {
				try {
					const now = Date.now();
					const current = segmentAt(segments, now);
					const grace = segmentGraceMs(segments);
					const trailing = cursor.trailing;
					const trailingDue = trailing !== null && now >= segmentEnd(segments, trailing.segment) + grace;
					// Late appends of the segment the cursor left, after its grace; then the segment goes.
					if (trailing !== null && trailingDue) {
						const late = await stream(trailing.segment).read(trailing.offset, false, signal);
						readFailures = 0;
						if (late === undefined || late.items.length === 0) {
							cursor = { ...cursor, trailing: null };
							await writeCursor(context.db, cursor);
							if (late !== undefined) {
								await stream(trailing.segment).delete().catch((error: unknown) => options.reportError(error));
							}
							continue;
						}
						if (await deliver(late.items)) {
							cursor = { ...cursor, failures: 0, trailing: { ...trailing, offset: late.nextOffset } };
							await writeCursor(context.db, cursor);
						}
						continue;
					}
					const segment = cursor.segment;
					if (segment >= current && createdSegment !== segment) {
						// Producers create it too; the consumer does so it can wait on it.
						await stream(segment).create(segmentExpiry(segments, segment));
						createdSegment = segment;
					}
					if (segment < current && cursor.offset === "-1" && !(await stream(segment).exists())) {
						await advance(current, null);
						continue;
					}
					// Producers append to a newer segment now, so an empty read means this one is done.
					const finished = segment < current;
					// A long-poll on a segment that ends during it waits out its timeout, while the events
					// go to the next segment. Near the end, short reads take its place.
					const untilEnd = segmentEnd(segments, segment) - now;
					const wait = !finished && untilEnd > longPollMs;
					const read = await stream(segment).read(cursor.offset, wait, signal);
					readFailures = 0;
					if (read === undefined) {
						// Deleted, expired, or never created. Only an older segment can be missing.
						if (segment < current) {
							if (cursor.offset !== "-1" || now >= segmentExpiry(segments, segment).getTime()) {
								options.reportError(
									new Error(`Tail events for ${consumer} in segment ${segment} expired before delivery`),
								);
							}
							await advance(current, null);
						}
						continue;
					}
					if (read.items.length === 0) {
						if (finished) {
							// One trailing segment at a time. Grace is at most one segment long, so the earlier
							// one is due by the time this one is done.
							if (trailing !== null) {
								await sleep(Math.min(1_000, segmentEnd(segments, trailing.segment) + grace - now), signal);
								continue;
							}
							await advance(current, { offset: read.nextOffset, segment });
						} else {
							if (read.nextOffset !== cursor.offset) {
								cursor = { ...cursor, offset: read.nextOffset };
								await writeCursor(context.db, cursor);
							}
							if (!wait) await sleep(Math.min(shortReadMs, Math.max(0, untilEnd)), signal);
						}
						continue;
					}
					if (await deliver(read.items)) {
						cursor = { ...cursor, failures: 0, offset: read.nextOffset };
						await writeCursor(context.db, cursor);
					}
				} catch (error: unknown) {
					if (signal.aborted) return;
					readFailures += 1;
					if (readFailures === 1) options.reportError(unreachable(consumer, error));
					await sleep(backoffMs(readFailures, 100, 10_000), signal);
				}
			}
		},
	});
}
