import {
	createExecutionContext,
	runInExecutionContext,
	type ExecutionContext,
} from "../context.js";
import { isRecord } from "../bindings/unknown-values.js";
import { isWorkerEntrypointClass } from "../modules/cloudflare-workers/worker-entrypoint.js";
import { finishEventTrace, startEventTrace, traceEventException } from "../internal/tail-trace.js";

const noRetryRequested = new WeakSet<ScheduledController>();

// The `controller` argument of a module Worker's `scheduled()` handler.
// https://github.com/cloudflare/workerd/blob/b73ce3ae105c35bafaaad864095079524573a465/src/workerd/api/scheduled.h#L45-L62
export class ScheduledController {
	readonly #cron: string;
	readonly #scheduledTime: number;

	constructor(scheduledTime: number, cron: string) {
		this.#scheduledTime = scheduledTime;
		this.#cron = cron;
	}

	get scheduledTime(): number {
		return this.#scheduledTime;
	}

	get cron(): string {
		return this.#cron;
	}

	noRetry(): void {
		noRetryRequested.add(this);
	}
}

export type ScheduledHandler<Props = unknown> = (
	controller: ScheduledController,
	environment: Record<string, unknown>,
	context: ExecutionContext<Props>,
) => unknown;

export interface ScheduledDispatchOptions<Props> {
	cron: string;
	environment: Record<string, unknown>;
	exports: object;
	// Undefined when the Worker does not export a scheduled() handler.
	handler: ScheduledHandler<Props> | undefined;
	props: Props;
	scheduledTime: number;
}

export interface ScheduledResult {
	// The handler error first, then each rejected waitUntil() promise.
	errors: unknown[];
	noRetry: boolean;
	outcome: "exception" | "ok";
}

// Workerd runs the scheduled handler as a waitUntil() task, so the event fails
// when the handler or any waitUntil() promise rejects. A Worker without a
// scheduled() handler fails the event and disables retries.
// https://github.com/cloudflare/workerd/blob/b73ce3ae105c35bafaaad864095079524573a465/src/workerd/api/global-scope.c%2B%2B#L525-L565
// https://github.com/cloudflare/workerd/blob/b73ce3ae105c35bafaaad864095079524573a465/src/workerd/io/io-context.c%2B%2B#L662-L699
export async function dispatchScheduled<Props>(
	options: ScheduledDispatchOptions<Props>,
): Promise<ScheduledResult> {
	const controller = new ScheduledController(options.scheduledTime, options.cron);
	const execution = createExecutionContext({
		exports: options.exports,
		props: options.props,
	});
	startEventTrace(execution.context, {
		cron: options.cron,
		scheduledTime: options.scheduledTime,
		type: "scheduled",
	});
	const handler = options.handler;
	const errors: unknown[] = [];
	if (handler === undefined) {
		errors.push(new Error("Handler does not export a scheduled() function"));
		controller.noRetry();
	} else {
		try {
			await runInExecutionContext(execution.context, () =>
				handler(controller, options.environment, execution.context),
			);
		} catch (error: unknown) {
			errors.push(error);
		}
	}
	for (const outcome of await execution.drainWaitUntil()) {
		if (outcome.status === "rejected") errors.push(outcome.reason);
	}
	for (const error of errors) traceEventException(execution.context, error);
	finishEventTrace(execution.context);
	execution.end();
	return {
		errors,
		noRetry: noRetryRequested.has(controller),
		outcome: errors.length === 0 ? "ok" : "exception",
	};
}

// An object default export's scheduled() runs as a method of that object. A
// WorkerEntrypoint class gets a new instance per event, and its scheduled()
// takes only the controller, as with fetch().
// https://github.com/cloudflare/workerd/blob/b73ce3ae105c35bafaaad864095079524573a465/src/workerd/api/workers-module.h#L27-L33
export function defaultScheduledHandler(defaultExport: unknown): ScheduledHandler | undefined {
	if (isWorkerEntrypointClass(defaultExport)) {
		if (typeof Reflect.get(defaultExport.prototype, "scheduled") !== "function") {
			return undefined;
		}
		return (controller, environment, context) => {
			const instance = Reflect.construct(defaultExport, [context, environment]);
			return Reflect.apply(Reflect.get(instance, "scheduled"), instance, [controller]);
		};
	}
	if (!isRecord(defaultExport)) return undefined;
	const handler = defaultExport.scheduled;
	if (typeof handler !== "function") return undefined;
	return (controller, environment, context) =>
		Reflect.apply(handler, defaultExport, [controller, environment, context]);
}
