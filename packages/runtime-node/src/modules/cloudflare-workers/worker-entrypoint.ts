import {
	currentExecutionContext,
	type ExecutionContext,
} from "../../context.js";

// Base class for named and default entrypoint classes. workerd stores the
// constructor arguments as `this.ctx` and `this.env`.
// https://github.com/cloudflare/workerd/blob/b73ce3ae105c35bafaaad864095079524573a465/src/workerd/api/workers-module.c%2B%2B#L12-L23
export abstract class WorkerEntrypoint<Env = unknown, Props = unknown> {
	protected ctx: ExecutionContext<Props>;
	protected env: Env;

	constructor(ctx: ExecutionContext<Props>, env: Env) {
		this.ctx = ctx;
		this.env = env;
	}
}

// Base class for Workflow classes. A Workflow binding constructs the class for
// each run of an instance and calls its `run(event, step)`.
// https://github.com/cloudflare/workerd/blob/b73ce3ae105c35bafaaad864095079524573a465/src/cloudflare/workers.ts#L19
export abstract class WorkflowEntrypoint<Env = unknown, _Params = unknown> {
	protected ctx: ExecutionContext;
	protected env: Env;

	constructor(ctx: ExecutionContext, env: Env) {
		this.ctx = ctx;
		this.env = env;
	}
}

export function isWorkerEntrypointClass(
	value: unknown,
): value is new (ctx: ExecutionContext, env: unknown) => object {
	return (
		typeof value === "function" &&
		Reflect.get(value, "prototype") instanceof WorkerEntrypoint
	);
}

// Registers background work on the event that is running, like
// `ctx.waitUntil()`, for code that has no `ctx` at hand.
// https://github.com/cloudflare/workerd/blob/b73ce3ae105c35bafaaad864095079524573a465/src/cloudflare/workers.ts#L156
export function waitUntil(promise: Promise<unknown>): void {
	const context = currentExecutionContext();
	if (context === undefined) {
		throw new Error(
			"Disallowed operation called within global scope. Asynchronous I/O (ex: fetch() or connect()), setting a timeout, and generating random values are not allowed within global scope. To fix this error, perform this operation within a handler. https://developers.cloudflare.com/workers/runtime-apis/handlers/",
		);
	}
	context.waitUntil(promise);
}
