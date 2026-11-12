import { randomBytes } from "node:crypto";

import {
	encodeQueueBody,
	parseQueueContentType,
	queueBodyBytes,
	type QueueContentType,
	type QueueEnvelope,
} from "./envelope.js";
import { rivetEnvoyMessageBytes } from "../../internal/rivet-limits.js";
import { errorMessage, isObject } from "../unknown-values.js";

// Calls an action on the `openorange:queue` actor of one queue.
export type QueueActorCaller = (
	queueName: string,
	action: string,
	args: readonly unknown[],
) => Promise<unknown>;

// A message on its way into the queue actor. A delayed message waits in a
// RivetKit schedule before it enters the queue.
export interface QueueDelivery {
	delayMs: number;
	envelope: QueueEnvelope;
}

export interface QueueMetrics {
	backlogBytes: number;
	backlogCount: number;
	oldestMessageTimestamp?: Date;
}

export interface QueueSendResponse {
	metadata: { metrics: QueueMetrics };
}

export interface QueueSendOptions {
	contentType?: string;
	delaySeconds?: number;
}

export interface QueueSendBatchOptions {
	delaySeconds?: number;
}

export interface MessageSendRequest {
	body: unknown;
	contentType?: string;
	delaySeconds?: number;
}

// Cloudflare delays a message by at most 24 hours. That is a Cloudflare quota, which Orange does
// not copy: the delay is a stored time.
function delayMs(delaySeconds: unknown): number {
	if (
		typeof delaySeconds !== "number" ||
		!Number.isInteger(delaySeconds) ||
		delaySeconds < 0 ||
		!Number.isSafeInteger(delaySeconds * 1000)
	) {
		throw new Error(
			`Queue send failed: message delay ${String(delaySeconds)} is invalid. It must be a whole number of seconds, 0 or more.`,
		);
	}
	return delaySeconds * 1000;
}

function parseMetrics(value: unknown): QueueMetrics {
	if (
		!isObject(value) ||
		typeof value.backlogBytes !== "number" ||
		typeof value.backlogCount !== "number"
	) {
		throw new Error("The OpenOrange queue actor returned invalid metrics");
	}
	return { backlogBytes: value.backlogBytes, backlogCount: value.backlogCount };
}

export interface WorkerQueueOptions {
	call: QueueActorCaller;
	// The producer's `delivery_delay` in seconds.
	deliveryDelay?: number;
	queueName: string;
}

// `env.QUEUE` for a `queues.producers` binding.
// https://github.com/cloudflare/workerd/blob/b73ce3ae105c35bafaaad864095079524573a465/src/workerd/api/queue.c%2B%2B#L237-L452
export class WorkerQueue {
	readonly #call: QueueActorCaller;
	readonly #deliveryDelay: number;
	readonly #queueName: string;

	constructor(options: WorkerQueueOptions) {
		this.#call = options.call;
		this.#deliveryDelay = options.deliveryDelay ?? 0;
		this.#queueName = options.queueName;
	}

	async send(body: unknown, options?: QueueSendOptions): Promise<QueueSendResponse> {
		const delivery = this.#delivery(
			body,
			options?.contentType,
			options?.delaySeconds ?? this.#deliveryDelay,
		);
		return { metadata: { metrics: await this.#enqueue([delivery]) } };
	}

	async sendBatch(
		messages: Iterable<MessageSendRequest>,
		options?: QueueSendBatchOptions,
	): Promise<QueueSendResponse> {
		const deliveries: QueueDelivery[] = [];
		for (const message of messages) {
			if (!isObject(message)) {
				throw new TypeError("sendBatch() requires an iterable of message objects");
			}
			deliveries.push(
				this.#delivery(
					message.body,
					message.contentType,
					message.delaySeconds ?? options?.delaySeconds ?? this.#deliveryDelay,
				),
			);
		}
		if (deliveries.length === 0) {
			throw new TypeError("sendBatch() requires at least one message");
		}
		return { metadata: { metrics: await this.#enqueue(deliveries) } };
	}

	async metrics(): Promise<QueueMetrics> {
		return parseMetrics(await this.#call(this.#queueName, "metrics", []));
	}

	#delivery(body: unknown, contentType: unknown, delaySeconds: unknown): QueueDelivery {
		if (body === undefined) {
			throw new TypeError("Message body cannot be undefined");
		}
		if (contentType !== undefined && typeof contentType !== "string") {
			throw new TypeError(`Unsupported queue message content type: ${String(contentType)}`);
		}
		const type: QueueContentType =
			contentType === undefined ? "json" : parseQueueContentType(contentType);
		return {
			delayMs: delayMs(delaySeconds),
			envelope: {
				attempts: 0,
				body: encodeQueueBody(body, type),
				contentType: type,
				// Cloudflare message IDs are 32 hexadecimal characters.
				id: randomBytes(16).toString("hex"),
				timestamp: Date.now(),
			},
		};
	}

	async #enqueue(deliveries: readonly QueueDelivery[]): Promise<QueueMetrics> {
		// One send() or sendBatch() reaches the queue actor as one action, and the Engine takes at most
		// 32 MiB in one message from a runner. Cloudflare's 128 KB message limit is not copied.
		// https://github.com/rivet-dev/actors/blob/cf8679c670bc1e0e22252a6daf0523b9a1771ed6/engine/packages/pegboard-envoy/src/routes.rs#L186
		const bytes = deliveries.reduce((total, { envelope }) => total + queueBodyBytes(envelope.body), 0);
		if (bytes > rivetEnvoyMessageBytes) {
			throw new RangeError(
				`Queue send failed: the messages are ${bytes} bytes. One send() or sendBatch() is one message to Rivet's Engine, which takes at most ${rivetEnvoyMessageBytes} bytes (32 MiB). Split the batch.`,
			);
		}
		let result: unknown;
		try {
			result = await this.#call(this.#queueName, "enqueue", [deliveries]);
		} catch (error: unknown) {
			throw new Error(`Queue send failed: ${errorMessage(error)}`, { cause: error });
		}
		return parseMetrics(result);
	}
}
