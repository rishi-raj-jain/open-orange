import { createExecutionContext, runInExecutionContext } from "../context.js";
import {
	createQueueEventResult,
	MessageBatch,
	type MessageBatchMetadata,
	type QueueEventResult,
} from "../bindings/queues/batch.js";
import type { QueueEnvelope } from "../bindings/queues/envelope.js";
import { isWorkerEntrypointClass } from "../modules/cloudflare-workers/worker-entrypoint.js";
import { isRecord } from "../bindings/unknown-values.js";
import { finishEventTrace, startEventTrace, traceEventException } from "../internal/tail-trace.js";

export type QueueHandler = (
	batch: MessageBatch,
	environment: Record<string, unknown>,
	context: object,
) => unknown;

// The `queue` handler of the Worker's default export: a method of a
// WorkerEntrypoint class, which gets a new instance per batch, or a function
// on the exported object.
export function defaultQueueHandler(defaultExport: unknown): QueueHandler | undefined {
	if (isWorkerEntrypointClass(defaultExport)) {
		if (typeof Reflect.get(defaultExport.prototype, "queue") !== "function") {
			return undefined;
		}
		return (batch, environment, context) => {
			const instance = Reflect.construct(defaultExport, [context, environment]);
			return Reflect.apply(Reflect.get(instance, "queue"), instance, [batch]);
		};
	}
	if (!isRecord(defaultExport)) return undefined;
	const handler = defaultExport.queue;
	if (typeof handler !== "function") return undefined;
	return (batch, environment, context) =>
		Reflect.apply(handler, defaultExport, [batch, environment, context]);
}

export interface QueueDispatch extends QueueEventResult {
	// The handler's error and the reasons of rejected waitUntil() promises.
	errors: unknown[];
}

export interface QueueDispatchOptions {
	envelopes: readonly QueueEnvelope[];
	environment: Record<string, unknown>;
	exports: object;
	handler: QueueHandler | undefined;
	metadata: MessageBatchMetadata;
	queueName: string;
}

// Runs one batch through the Worker's queue() handler. The batch completes
// after the handler and its waitUntil() promises settle, because Orange's
// profile leaves `queue_consumer_no_wait_for_wait_until` off. Any failure
// fails the batch.
// https://github.com/cloudflare/workerd/blob/b73ce3ae105c35bafaaad864095079524573a465/src/workerd/api/queue.c%2B%2B#L798-L811
export async function dispatchQueue(options: QueueDispatchOptions): Promise<QueueDispatch> {
	const result = createQueueEventResult();
	const errors: unknown[] = [];
	const controller = createExecutionContext({ exports: options.exports, props: undefined });
	startEventTrace(controller.context, {
		batchSize: options.envelopes.length,
		queue: options.queueName,
		type: "queue",
	});
	try {
		const batch = new MessageBatch(
			options.queueName,
			options.envelopes,
			options.metadata,
			result,
		);
		const handler = options.handler;
		if (handler === undefined) {
			// https://github.com/cloudflare/workerd/blob/b73ce3ae105c35bafaaad864095079524573a465/src/workerd/api/queue.c%2B%2B#L647-L651
			throw new Error("Handler does not export a queue() function.");
		}
		await runInExecutionContext(controller.context, () =>
			handler(batch, options.environment, controller.context),
		);
	} catch (error: unknown) {
		errors.push(error);
	}
	for (const outcome of await controller.drainWaitUntil()) {
		if (outcome.status === "rejected") errors.push(outcome.reason);
	}
	for (const error of errors) traceEventException(controller.context, error);
	finishEventTrace(controller.context);
	controller.end();
	return { ...result, errors };
}
