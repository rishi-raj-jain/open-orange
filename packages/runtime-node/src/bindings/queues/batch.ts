import { decodeQueueBody, type QueueEnvelope } from "./envelope.js";

export interface QueueRetryOptions {
	delaySeconds?: number;
}

export interface MessageBatchMetrics {
	backlogBytes: number;
	backlogCount: number;
	oldestMessageTimestamp?: Date;
}

export interface MessageBatchMetadata {
	metrics: MessageBatchMetrics;
}

// What the handler asked for. Like workerd, the first conflicting call wins and
// later ones only log a warning.
// https://github.com/cloudflare/workerd/blob/b73ce3ae105c35bafaaad864095079524573a465/src/workerd/api/queue.c%2B%2B#L473-L520
// https://github.com/cloudflare/workerd/blob/b73ce3ae105c35bafaaad864095079524573a465/src/workerd/api/queue.c%2B%2B#L574-L598
export interface QueueEventResult {
	ackAll: boolean;
	explicitAcks: Set<string>;
	retries: Map<string, QueueRetryOptions>;
	retryBatch: { delaySeconds?: number; retry: boolean };
}

export function createQueueEventResult(): QueueEventResult {
	return {
		ackAll: false,
		explicitAcks: new Set(),
		retries: new Map(),
		retryBatch: { retry: false },
	};
}

function retryDelaySeconds(options: QueueRetryOptions | undefined): number | undefined {
	const delaySeconds = options?.delaySeconds;
	return typeof delaySeconds === "number" && Number.isFinite(delaySeconds)
		? Math.max(0, Math.trunc(delaySeconds))
		: undefined;
}

export class Message {
	readonly #attempts: number;
	readonly #body: unknown;
	readonly #id: string;
	readonly #result: QueueEventResult;
	readonly #timestamp: number;

	constructor(envelope: QueueEnvelope, result: QueueEventResult) {
		this.#attempts = envelope.attempts + 1;
		this.#body = decodeQueueBody(envelope);
		this.#id = envelope.id;
		this.#result = result;
		this.#timestamp = envelope.timestamp;
	}

	get id(): string {
		return this.#id;
	}

	get timestamp(): Date {
		return new Date(this.#timestamp);
	}

	get body(): unknown {
		return this.#body;
	}

	get attempts(): number {
		return this.#attempts;
	}

	retry(options?: QueueRetryOptions): void {
		if (this.#result.ackAll) {
			console.warn(
				`Received a call to retry() on message ${this.#id} after ackAll() was already called. Calling retry() on a message after calling ackAll() has no effect.`,
			);
			return;
		}
		if (this.#result.explicitAcks.has(this.#id)) {
			console.warn(
				`Received a call to retry() on message ${this.#id} after ack() was already called. Calling retry() on a message after calling ack() has no effect.`,
			);
			return;
		}
		const entry = this.#result.retries.get(this.#id) ?? {};
		const delaySeconds = retryDelaySeconds(options);
		if (delaySeconds !== undefined) entry.delaySeconds = delaySeconds;
		this.#result.retries.set(this.#id, entry);
	}

	ack(): void {
		if (this.#result.ackAll) return;
		if (this.#result.retryBatch.retry) {
			console.warn(
				`Received a call to ack() on message ${this.#id} after retryAll() was already called. Calling ack() on a message after calling retryAll() has no effect.`,
			);
			return;
		}
		if (this.#result.retries.has(this.#id)) {
			console.warn(
				`Received a call to ack() on message ${this.#id} after retry() was already called. Calling ack() on a message after calling retry() has no effect.`,
			);
			return;
		}
		this.#result.explicitAcks.add(this.#id);
	}
}

export class MessageBatch {
	readonly #messages: readonly Message[];
	readonly #metadata: MessageBatchMetadata;
	readonly #queue: string;
	readonly #result: QueueEventResult;

	constructor(
		queue: string,
		envelopes: readonly QueueEnvelope[],
		metadata: MessageBatchMetadata,
		result: QueueEventResult,
	) {
		this.#messages = Object.freeze(envelopes.map((envelope) => new Message(envelope, result)));
		this.#metadata = metadata;
		this.#queue = queue;
		this.#result = result;
	}

	get messages(): readonly Message[] {
		return this.#messages;
	}

	get queue(): string {
		return this.#queue;
	}

	get metadata(): MessageBatchMetadata {
		return this.#metadata;
	}

	retryAll(options?: QueueRetryOptions): void {
		if (this.#result.ackAll) {
			console.warn(
				"Received a call to retryAll() after ackAll() was already called. Calling retryAll() after calling ackAll() has no effect.",
			);
			return;
		}
		this.#result.retryBatch.retry = true;
		const delaySeconds = retryDelaySeconds(options);
		if (delaySeconds !== undefined) this.#result.retryBatch.delaySeconds = delaySeconds;
	}

	ackAll(): void {
		if (this.#result.retryBatch.retry) {
			console.warn(
				"Received a call to ackAll() after retryAll() was already called. Calling ackAll() after calling retryAll() has no effect.",
			);
			return;
		}
		this.#result.ackAll = true;
	}
}

export type QueueMessageOutcome =
	| { kind: "ack" }
	| { delaySeconds: number; kind: "retry" };

// A call on one message wins over a batch call, and an explicit ack holds
// even when the handler throws. Other messages retry when the handler threw or
// called retryAll(). The delay is the message's, then the batch's, then the
// consumer's `retry_delay`.
// https://github.com/cloudflare/cloudflare-docs/blob/e65ba8b1fa64a5dc7c5c42a96c455398945cdf5e/src/content/docs/queues/configuration/batching-retries.mdx#L124-L130
// https://github.com/cloudflare/workers-sdk/blob/be87ff0382c53a294e948e49419d25d653c50e86/packages/miniflare/src/workers/queues/broker.worker.ts#L329-L356
export function queueMessageOutcome(
	result: QueueEventResult,
	handlerFailed: boolean,
	messageId: string,
	defaultRetryDelaySeconds: number,
): QueueMessageOutcome {
	if (result.explicitAcks.has(messageId)) return { kind: "ack" };
	const batchDelaySeconds = result.retryBatch.delaySeconds ?? defaultRetryDelaySeconds;
	const retry = result.retries.get(messageId);
	if (retry !== undefined) {
		return { delaySeconds: retry.delaySeconds ?? batchDelaySeconds, kind: "retry" };
	}
	if (result.ackAll) return { kind: "ack" };
	if (result.retryBatch.retry || handlerFailed) {
		return { delaySeconds: batchDelaySeconds, kind: "retry" };
	}
	return { kind: "ack" };
}
