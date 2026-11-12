import type { MessageBatchMetadata } from "../bindings/queues/batch.js";
import { queueMessageOutcome } from "../bindings/queues/batch.js";
import {
	parseQueueContentType,
	parseQueueEnvelope,
	queueBodyBytes,
	type QueueEnvelope,
} from "../bindings/queues/envelope.js";
import type { QueueDelivery, QueueMetrics } from "../bindings/queues/producer.js";
import type { QueueDispatch } from "../events/queue.js";
import {
	createRivetInternalActorDefinition,
	createRivetRawDatabaseProvider,
	type RivetInternalActorContext,
	type RivetInternalActorDefinition,
	type RivetRawDatabase,
} from "../internal/rivetkit.js";
import type { RuntimeQueueConsumer } from "../process-protocol.js";
import { isRecord } from "../bindings/unknown-values.js";

// One actor per Cloudflare queue, keyed by the queue name. Messages are rows in
// the actor's SQLite until the consumer acks them, so they survive restarts.
export const queueActorName = "openorange:queue";


// `seq` orders delivery. The index serves the available-message scan, the
// next-wake lookup, and the backlog sums without reading the table.
const schema = [
	`CREATE TABLE IF NOT EXISTS messages (
		seq INTEGER PRIMARY KEY AUTOINCREMENT,
		id TEXT NOT NULL,
		body BLOB NOT NULL,
		body_bytes INTEGER NOT NULL,
		content_type TEXT NOT NULL,
		enqueued_at INTEGER NOT NULL,
		available_at INTEGER NOT NULL,
		attempts INTEGER NOT NULL
	)`,
	"CREATE INDEX IF NOT EXISTS messages_available_at ON messages (available_at, body_bytes)",
];

type QueueActorContext = RivetInternalActorContext<Record<string, never>>;

interface QueuedMessage {
	envelope: QueueEnvelope;
	seq: number;
}

export interface QueueActorOptions {
	consumers: ReadonlyMap<string, RuntimeQueueConsumer>;
	dispatch(
		queueName: string,
		envelopes: readonly QueueEnvelope[],
		metadata: MessageBatchMetadata,
	): Promise<QueueDispatch>;
	// Sends dead-lettered messages to another queue.
	forward(queueName: string, envelopes: readonly QueueEnvelope[]): Promise<void>;
	reportError(error: unknown): void;
}

// Wakes a waiting consumer loop. A waiter passes the generation it read before
// its last query, so a notify that lands during the query is not lost.
class Wakeup {
	generation = 0;
	#waiters = new Set<() => void>();

	notify(): void {
		this.generation += 1;
		for (const resolve of this.#waiters) resolve();
		this.#waiters.clear();
	}

	async wait(generation: number, timeoutMs: number, signal: AbortSignal): Promise<void> {
		if (generation !== this.generation || signal.aborted) return;
		await new Promise<void>((resolve) => {
			const done = (): void => {
				clearTimeout(timer);
				signal.removeEventListener("abort", done);
				this.#waiters.delete(done);
				resolve();
			};
			const timer = Number.isFinite(timeoutMs) ? setTimeout(done, Math.max(0, timeoutMs)) : undefined;
			signal.addEventListener("abort", done, { once: true });
			this.#waiters.add(done);
		});
	}
}

function parseDeliveries(value: unknown): QueueDelivery[] {
	if (!Array.isArray(value)) {
		throw new TypeError("OpenOrange received an invalid queue enqueue request");
	}
	return value.map((delivery: unknown) => {
		if (!isRecord(delivery) || typeof delivery.delayMs !== "number") {
			throw new TypeError("OpenOrange received an invalid queue enqueue request");
		}
		return { delayMs: delivery.delayMs, envelope: parseQueueEnvelope(delivery.envelope) };
	});
}

function storedBody(value: unknown): QueueEnvelope["body"] | undefined {
	if (typeof value === "string") return value;
	if (ArrayBuffer.isView(value)) {
		return new Uint8ClampedArray(value.buffer, value.byteOffset, value.byteLength);
	}
	if (value instanceof ArrayBuffer) return new Uint8ClampedArray(value);
	if (Array.isArray(value) && value.every((byte) => typeof byte === "number")) {
		return Uint8ClampedArray.from(value);
	}
	return undefined;
}

function parseQueuedMessage(row: Record<string, unknown>): QueuedMessage {
	const id = String(row.id);
	const body = storedBody(row.body);
	if (body === undefined) {
		throw new Error(
			`Queue message ${id} has an invalid stored body of type ${Object.prototype.toString.call(row.body)}`,
		);
	}
	return {
		envelope: {
			attempts: Number(row.attempts),
			body,
			contentType: parseQueueContentType(String(row.content_type)),
			id,
			timestamp: Number(row.enqueued_at),
		},
		seq: Number(row.seq),
	};
}

// The backlog is every message that is due, like the queue the actor used before.
async function metrics(database: RivetRawDatabase): Promise<QueueMetrics> {
	const [row] = await database.execute(
		"SELECT COUNT(*) AS count, COALESCE(SUM(body_bytes), 0) AS bytes FROM messages WHERE available_at <= ?",
		Date.now(),
	);
	return { backlogBytes: Number(row?.bytes ?? 0), backlogCount: Number(row?.count ?? 0) };
}

async function enqueue(database: RivetRawDatabase, deliveries: readonly QueueDelivery[]): Promise<void> {
	const now = Date.now();
	await database.transaction(async (tx) => {
		for (const { delayMs, envelope } of deliveries) {
			await tx.execute(
				"INSERT INTO messages (id, body, body_bytes, content_type, enqueued_at, available_at, attempts) VALUES (?, ?, ?, ?, ?, ?, ?)",
				envelope.id,
				// RivetKit binds only Uint8Array as a blob.
				typeof envelope.body === "string"
					? envelope.body
					: new Uint8Array(envelope.body.buffer, envelope.body.byteOffset, envelope.body.byteLength),
				queueBodyBytes(envelope.body),
				envelope.contentType,
				envelope.timestamp,
				now + Math.max(0, delayMs),
				envelope.attempts,
			);
		}
	});
}

// Settles one delivered batch. Dead letters are sent before their rows are
// deleted, so a crash at any point redelivers instead of losing a message.
async function settle(
	context: QueueActorContext,
	consumer: RuntimeQueueConsumer,
	messages: readonly QueuedMessage[],
	options: QueueActorOptions,
): Promise<void> {
	const envelopes = messages.map((message) => message.envelope);
	const backlog = await metrics(context.db);
	const dispatch = await options.dispatch(consumer.queueName, envelopes, {
		metrics: {
			backlogBytes: Math.max(
				0,
				backlog.backlogBytes -
					envelopes.reduce((total, envelope) => total + queueBodyBytes(envelope.body), 0),
			),
			backlogCount: Math.max(0, backlog.backlogCount - envelopes.length),
		},
	});
	for (const error of dispatch.errors) options.reportError(error);
	const removed: number[] = [];
	const retried: { attempts: number; availableAt: number; seq: number }[] = [];
	const deadLetters: QueueEnvelope[] = [];
	const now = Date.now();
	for (const { envelope, seq } of messages) {
		const outcome = queueMessageOutcome(
			dispatch,
			dispatch.errors.length > 0,
			envelope.id,
			consumer.retryDelay,
		);
		if (outcome.kind === "ack") {
			removed.push(seq);
			continue;
		}
		// Like Cloudflare, a message gets `max_retries + 1` deliveries.
		// https://github.com/cloudflare/workers-sdk/blob/be87ff0382c53a294e948e49419d25d653c50e86/packages/miniflare/src/workers/queues/broker.worker.ts#L340-L368
		const failedAttempts = envelope.attempts + 1;
		if (failedAttempts <= consumer.maxRetries) {
			retried.push({
				attempts: failedAttempts,
				availableAt: now + outcome.delaySeconds * 1000,
				seq,
			});
			continue;
		}
		removed.push(seq);
		if (consumer.deadLetterQueue !== undefined) {
			deadLetters.push({ ...envelope, attempts: 0 });
		} else {
			const attempts = consumer.maxRetries + 1;
			options.reportError(
				new Error(
					`Dropped message "${envelope.id}" on queue "${consumer.queueName}" after ${attempts} failed attempt${attempts === 1 ? "" : "s"}!`,
				),
			);
		}
	}
	if (consumer.deadLetterQueue !== undefined && deadLetters.length > 0) {
		await options.forward(consumer.deadLetterQueue, deadLetters);
	}
	await context.db.transaction(async (tx) => {
		if (removed.length > 0) {
			await tx.execute(
				`DELETE FROM messages WHERE seq IN (${removed.map(() => "?").join(", ")})`,
				...removed,
			);
		}
		for (const retry of retried) {
			await tx.execute(
				"UPDATE messages SET attempts = ?, available_at = ? WHERE seq = ?",
				retry.attempts,
				retry.availableAt,
				retry.seq,
			);
		}
	});
}

// Delivers batches to the Worker's queue() handler, one batch at a time.
async function consume(
	context: QueueActorContext,
	consumer: RuntimeQueueConsumer,
	wakeup: Wakeup,
	options: QueueActorOptions,
): Promise<void> {
	const database = context.db;
	const signal = context.abortSignal;
	const batchTimeoutMs = consumer.maxBatchTimeout * 1000;
	// When the first due message of a partial batch was seen.
	let batchDeadline: number | undefined;
	// The time of the wake-up schedule this run already set.
	let scheduledWakeAt: number | undefined;
	while (!signal.aborted) {
		const generation = wakeup.generation;
		const now = Date.now();
		const [next] = await database.execute(
			"SELECT MIN(available_at) AS next FROM messages",
		);
		const nextAvailableAt = next?.next === null || next?.next === undefined ? undefined : Number(next.next);
		if (nextAvailableAt === undefined) {
			await wakeup.wait(generation, Number.POSITIVE_INFINITY, signal);
			continue;
		}
		if (nextAvailableAt > now) {
			// The schedule restarts this loop if the actor sleeps before the message is due.
			if (scheduledWakeAt !== nextAvailableAt) {
				await context.schedule.after(nextAvailableAt - now, "wake");
				scheduledWakeAt = nextAvailableAt;
			}
			await wakeup.wait(generation, nextAvailableAt - now, signal);
			continue;
		}
		if (batchTimeoutMs > 0) {
			batchDeadline ??= now + batchTimeoutMs;
			if (now < batchDeadline) {
				const [due] = await database.execute(
					"SELECT COUNT(*) AS count FROM (SELECT 1 FROM messages WHERE available_at <= ? LIMIT ?)",
					now,
					consumer.maxBatchSize,
				);
				if (Number(due?.count ?? 0) < consumer.maxBatchSize) {
					await wakeup.wait(generation, batchDeadline - now, signal);
					continue;
				}
			}
		}
		batchDeadline = undefined;
		const rows = await database.execute(
			"SELECT seq, id, body, content_type, enqueued_at, attempts FROM messages WHERE available_at <= ? ORDER BY available_at, seq LIMIT ?",
			now,
			consumer.maxBatchSize,
		);
		if (rows.length > 0) await settle(context, consumer, rows.map(parseQueuedMessage), options);
	}
}

export function createQueueActorDefinition(
	options: QueueActorOptions,
): RivetInternalActorDefinition {
	// The running consumer loop of each queue actor in this process, by queue name.
	const wakeups = new Map<string, Wakeup>();
	const notify = (context: QueueActorContext): void => {
		const queueName = context.key[0];
		if (queueName !== undefined) wakeups.get(queueName)?.notify();
	};
	return createRivetInternalActorDefinition<Record<string, never>>({
		actions: {
			enqueue: async (context, deliveries: unknown): Promise<QueueMetrics> => {
				await enqueue(context.db, parseDeliveries(deliveries));
				notify(context);
				return await metrics(context.db);
			},
			metrics: (context): Promise<QueueMetrics> => metrics(context.db),
			// Starts the consumer loop of a sleeping queue actor, and the schedule
			// target for delayed and retried messages.
			wake: (context): void => notify(context),
		},
		db: createRivetRawDatabaseProvider(async (database) => {
			for (const statement of schema) await database.execute(statement);
		}),
		options: {
			name: "Queues (Orange)",
		},
		async run(context): Promise<void> {
			const queueName = context.key[0];
			const consumer = queueName === undefined ? undefined : options.consumers.get(queueName);
			// Without a consumer in this Worker, messages wait in the queue.
			if (queueName === undefined || consumer === undefined) return;
			const wakeup = new Wakeup();
			wakeups.set(queueName, wakeup);
			try {
				await consume(context, consumer, wakeup, options);
			} catch (error: unknown) {
				// Sleep and shutdown abort the loop mid-query.
				if (!context.abortSignal.aborted) throw error;
			} finally {
				if (wakeups.get(queueName) === wakeup) wakeups.delete(queueName);
			}
		},
	});
}
