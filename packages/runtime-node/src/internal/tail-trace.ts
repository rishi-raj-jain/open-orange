import { types } from "node:util";

import { currentExecutionContext, type ExecutionContext } from "../context.js";
import type { Request } from "../globals/http.js";

// Tail Workers: each traced event of a Worker becomes one trace record, and the
// Worker's tail consumers get it in their tail() handler once the event ends.
// https://developers.cloudflare.com/workers/observability/logs/tail-workers/

/** The event that a trace describes, as plain data that crosses a process boundary. */
export type TraceEventRecord =
	| {
			readonly type: "fetch";
			readonly request: {
				/** `request.cf` as JSON, when the request has one. */
				readonly cf?: string;
				readonly headers: readonly (readonly [string, string])[];
				readonly method: string;
				readonly url: string;
			};
			readonly response?: { readonly status: number };
	  }
	| { readonly type: "queue"; readonly batchSize: number; readonly queue: string }
	| { readonly type: "scheduled"; readonly cron: string; readonly scheduledTime: number };

export interface TraceErrorInfoRecord {
	readonly message: string;
	readonly name: string;
	readonly stack?: string;
}

export interface TraceLogRecord {
	/** Set when an argument was a native Error. Slot `i` describes argument `i`. */
	readonly errorInfo?: readonly (TraceErrorInfoRecord | null)[];
	readonly level: string;
	/** The console arguments as a JSON array. */
	readonly message: string;
	readonly timestamp: number;
}

export interface TraceExceptionRecord extends TraceErrorInfoRecord {
	readonly timestamp: number;
}

/** One finished event, as plain JSON data. */
export interface TraceRecord {
	readonly entrypoint?: string;
	readonly event: TraceEventRecord;
	readonly eventTimestamp: number;
	readonly exceptions: readonly TraceExceptionRecord[];
	readonly logs: readonly TraceLogRecord[];
	readonly outcome: string;
	readonly scriptName: string | null;
	readonly wallTime: number;
}

export interface TailConsumers {
	readonly scriptName: string | null;
	deliver(record: TraceRecord): void;
}

interface ActiveTrace {
	readonly entrypoint?: string;
	event: TraceEventRecord;
	readonly eventTimestamp: number;
	readonly exceptions: TraceExceptionRecord[];
	readonly logs: TraceLogRecord[];
	outcome: string;
	readonly started: number;
}

let consumers: TailConsumers | undefined;
const activeTraces = new WeakMap<ExecutionContext, ActiveTrace>();

/** Sends this Worker's traces to its tail consumers. Without a call, events are not traced. */
export function configureTailConsumers(target: TailConsumers): void {
	consumers = target;
	installConsoleCapture();
}

/** Starts tracing the event that runs in `context`. */
export function startEventTrace(
	context: ExecutionContext,
	event: TraceEventRecord,
	entrypoint?: string,
): void {
	if (consumers === undefined) return;
	activeTraces.set(context, {
		...(entrypoint === undefined || entrypoint === "default" ? {} : { entrypoint }),
		event,
		eventTimestamp: Date.now(),
		exceptions: [],
		logs: [],
		outcome: "ok",
		started: performance.now(),
	});
}

/** Records the status of the Response that a traced fetch event returned. */
export function traceFetchResponse(context: ExecutionContext, status: number): void {
	const trace = activeTraces.get(context);
	if (trace?.event.type !== "fetch") return;
	trace.event = { ...trace.event, response: { status } };
}

/** Records an error that a traced event's handler threw. The event's outcome becomes "exception". */
export function traceEventException(context: ExecutionContext, error: unknown): void {
	const trace = activeTraces.get(context);
	if (trace === undefined) return;
	trace.outcome = "exception";
	trace.exceptions.push({ timestamp: Date.now(), ...errorInfoForTrace(error) });
}

/** Ends the traced event and hands its record to the tail consumers. */
export function finishEventTrace(context: ExecutionContext): void {
	const trace = activeTraces.get(context);
	if (trace === undefined || consumers === undefined) return;
	activeTraces.delete(context);
	consumers.deliver({
		...(trace.entrypoint === undefined ? {} : { entrypoint: trace.entrypoint }),
		event: trace.event,
		eventTimestamp: trace.eventTimestamp,
		exceptions: trace.exceptions,
		logs: trace.logs,
		outcome: trace.outcome,
		scriptName: consumers.scriptName,
		wallTime: Math.round(performance.now() - trace.started),
	});
}

/** The fetch event of `request`, as a trace records it. */
export function fetchTraceEvent(request: Request): TraceEventRecord {
	const cf: unknown = Reflect.get(request, "cf");
	let cfJson: string | undefined;
	try {
		cfJson = cf === undefined || cf === null ? undefined : JSON.stringify(cf);
	} catch {
		cfJson = undefined;
	}
	return {
		request: {
			...(cfJson === undefined ? {} : { cf: cfJson }),
			headers: [...request.headers],
			method: request.method,
			url: request.url,
		},
		type: "fetch",
	};
}

// Workerd's name, message, and stack for an error in a trace. The stack drops the
// leading "Name: message" line, which repeats the other two fields.
// https://github.com/cloudflare/workerd/blob/b73ce3ae105c35bafaaad864095079524573a465/src/workerd/io/worker.c%2B%2B#L188-L257
function errorInfoForTrace(error: unknown): TraceErrorInfoRecord {
	const read = (key: string): unknown =>
		typeof error === "object" && error !== null ? Reflect.get(error, key) : undefined;
	const nameValue = read("name");
	const messageValue = read("message");
	const stackValue = read("stack");
	const name = nameValue === undefined ? "Error" : String(nameValue);
	let message = "";
	if (messageValue !== undefined) {
		message = String(messageValue);
	} else {
		try {
			message = String(error);
		} catch {
			// A value that cannot be stringified keeps an empty message.
		}
	}
	let stack: string | undefined;
	if (stackValue !== undefined) {
		let slice = String(stackValue);
		if (slice.startsWith(name)) {
			slice = slice.slice(name.length);
			if (slice.startsWith(": ")) slice = slice.slice(2);
		}
		if (slice.startsWith(message)) {
			slice = slice.slice(message.length);
			if (slice.startsWith("\n")) slice = slice.slice(1);
		}
		if (slice.length > 0) stack = slice;
	}
	return { message, name, ...(stack === undefined ? {} : { stack }) };
}

// Workerd writes JSON for primitives, arrays, plain objects, and objects with a
// toJSON() method, and a JSON string of String(value) for everything else.
// https://github.com/cloudflare/workerd/blob/b73ce3ae105c35bafaaad864095079524573a465/src/workerd/io/worker.c%2B%2B#L2192-L2261
function logArgumentJson(argument: unknown): string {
	try {
		if (serializesAsJson(argument)) return JSON.stringify(argument) ?? "null";
		// V8's ToString throws for a Symbol, so workerd writes {} for it.
		if (typeof argument === "symbol") return "{}";
		return JSON.stringify(String(argument));
	} catch {
		return "{}";
	}
}

function serializesAsJson(argument: unknown): boolean {
	if (typeof argument !== "object" || argument === null) {
		return (
			argument === null ||
			argument === undefined ||
			typeof argument === "number" ||
			typeof argument === "boolean" ||
			typeof argument === "string"
		);
	}
	const prototype: unknown = Object.getPrototypeOf(argument);
	return (
		Array.isArray(argument) ||
		prototype === Object.prototype ||
		prototype === null ||
		typeof Reflect.get(argument, "toJSON") === "function"
	);
}

// https://github.com/cloudflare/workerd/blob/b73ce3ae105c35bafaaad864095079524573a465/src/workerd/io/worker.c%2B%2B#L2267-L2319
function logErrorInfo(argumentsList: readonly unknown[]): (TraceErrorInfoRecord | null)[] | undefined {
	let slots: (TraceErrorInfoRecord | null)[] | undefined;
	argumentsList.forEach((argument, index) => {
		if (!types.isNativeError(argument)) return;
		let info: TraceErrorInfoRecord;
		try {
			info = errorInfoForTrace(argument);
		} catch {
			// A throwing getter skips this argument, as in workerd.
			return;
		}
		slots ??= argumentsList.map(() => null);
		slots[index] = info;
	});
	return slots;
}

// https://github.com/cloudflare/workerd/blob/b73ce3ae105c35bafaaad864095079524573a465/src/workerd/io/worker.c%2B%2B#L1802-L1806
const consoleLevels = ["debug", "error", "info", "log", "warn"] as const;
let consoleCaptured = false;

function installConsoleCapture(): void {
	if (consoleCaptured) return;
	consoleCaptured = true;
	for (const level of consoleLevels) {
		const original = console[level];
		console[level] = function (this: unknown, ...argumentsList: unknown[]): void {
			Reflect.apply(original, this, argumentsList);
			const context = currentExecutionContext();
			const trace = context === undefined ? undefined : activeTraces.get(context);
			if (trace === undefined) return;
			const errorInfo = logErrorInfo(argumentsList);
			trace.logs.push({
				...(errorInfo === undefined ? {} : { errorInfo }),
				level,
				message: `[${argumentsList.map(logArgumentJson).join(", ")}]`,
				timestamp: Date.now(),
			});
		};
	}
}
