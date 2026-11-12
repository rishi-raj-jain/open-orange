import {
	createExecutionContext,
	releaseExecutionContext,
	runInExecutionContext,
} from "../context.js";
import type { LoopbackWorker } from "../bindings/service.js";
import type { TraceEventRecord, TraceRecord } from "../internal/tail-trace.js";
import { isWorkerEntrypointClass } from "../modules/cloudflare-workers/worker-entrypoint.js";

// The TraceItem objects that a tail() handler receives.
// https://github.com/cloudflare/workerd/blob/b73ce3ae105c35bafaaad864095079524573a465/src/workerd/api/trace.c%2B%2B#L206-L225

// https://github.com/cloudflare/workerd/blob/b73ce3ae105c35bafaaad864095079524573a465/src/workerd/api/trace.c%2B%2B#L383-L401
function redactedHeaderName(name: string): boolean {
	return (
		name === "cookie" ||
		name === "set-cookie" ||
		["auth", "jwt", "key", "secret", "token"].some((part) => name.includes(part))
	);
}

const separators = new Set(["+", "-", "_"]);

// https://github.com/cloudflare/workerd/blob/b73ce3ae105c35bafaaad864095079524573a465/src/workerd/api/util.c%2B%2B#L160-L181
function isLuhnPan(span: string): boolean {
	let digits = 0;
	let sum = 0;
	let double = false;
	for (let index = span.length - 1; index >= 0; index -= 1) {
		const character = span[index] ?? "";
		if (separators.has(character)) continue;
		if (character < "0" || character > "9") return false;
		let digit = character.charCodeAt(0) - 48;
		if (double) {
			digit *= 2;
			if (digit > 9) digit -= 9;
		}
		sum += digit;
		digits += 1;
		double = !double;
	}
	return digits >= 13 && digits <= 19 && sum % 10 === 0;
}

// Replaces URL segments that look like IDs or card numbers with REDACTED.
// https://github.com/cloudflare/workerd/blob/b73ce3ae105c35bafaaad864095079524573a465/src/workerd/api/util.c%2B%2B#L186-L252
function redactUrl(url: string): string {
	let redacted = "";
	let span = "";
	let sawNonHex = false;
	let digits = 0;
	let upper = 0;
	let lower = 0;
	let hexDigits = 0;
	const flush = (): void => {
		const hexId = hexDigits >= 32 && !sawNonHex;
		const base64Id = span.length >= 21 && digits >= 2 && upper >= 2 && lower >= 2;
		redacted += hexId || base64Id || isLuhnPan(span) ? "REDACTED" : span;
		span = "";
		sawNonHex = false;
		digits = 0;
		upper = 0;
		lower = 0;
		hexDigits = 0;
	};
	for (const character of url) {
		const isUpper = character >= "A" && character <= "Z";
		const isLower = character >= "a" && character <= "z";
		const isDigit = character >= "0" && character <= "9";
		const isSeparator = separators.has(character);
		if (isUpper || isLower || isDigit || isSeparator) {
			const isHex = isDigit || (character >= "a" && character <= "f") || (character >= "A" && character <= "F");
			if (isHex) hexDigits += 1;
			if (!isHex && !isSeparator) sawNonHex = true;
			if (isUpper) upper += 1;
			if (isLower) lower += 1;
			if (isDigit) digits += 1;
			span += character;
		} else {
			flush();
			redacted += character;
		}
	}
	flush();
	return redacted;
}

interface FetchRequestDetail {
	readonly cf: unknown;
	readonly headers: readonly (readonly [string, string])[];
	readonly method: string;
	readonly url: string;
}

// Both the redacted and the unredacted request share one `cf` object, as in workerd.
// https://github.com/cloudflare/workerd/blob/b73ce3ae105c35bafaaad864095079524573a465/src/workerd/api/trace.c%2B%2B#L371-L414
function traceRequest(detail: FetchRequestDetail, redacted: boolean): object {
	const headers: Record<string, string> = {};
	for (const [name, value] of detail.headers) {
		headers[name] = redacted && redactedHeaderName(name) ? "REDACTED" : value;
	}
	return {
		cf: detail.cf,
		getUnredacted: (): object => traceRequest(detail, false),
		headers,
		method: detail.method,
		url: redacted ? redactUrl(detail.url) : detail.url,
	};
}

function traceEvent(event: TraceEventRecord): object {
	switch (event.type) {
		case "fetch": {
			const detail: FetchRequestDetail = {
				cf: event.request.cf === undefined ? undefined : JSON.parse(event.request.cf),
				headers: event.request.headers,
				method: event.request.method,
				url: event.request.url,
			};
			return {
				request: traceRequest(detail, true),
				...(event.response === undefined ? {} : { response: { status: event.response.status } }),
			};
		}
		case "queue":
			return { batchSize: event.batchSize, queue: event.queue };
		case "scheduled":
			return { cron: event.cron, scheduledTime: event.scheduledTime };
	}
}

function traceItem(record: TraceRecord): object {
	return {
		cpuTime: 0,
		diagnosticsChannelEvents: [],
		...(record.entrypoint === undefined ? {} : { entrypoint: record.entrypoint }),
		event: traceEvent(record.event),
		eventTimestamp: record.eventTimestamp,
		exceptions: record.exceptions.map((exception) => ({ ...exception })),
		executionModel: "stateless",
		logs: record.logs.map((log) => ({
			...(log.errorInfo === undefined
				? {}
				: { errorInfo: log.errorInfo.map((info) => (info === null ? null : { ...info })) }),
			level: log.level,
			message: JSON.parse(log.message),
			timestamp: log.timestamp,
		})),
		outcome: record.outcome,
		scriptName: record.scriptName,
		truncated: false,
		wallTime: record.wallTime,
	};
}

/**
 * Runs the Worker's tail() handler with `records`. Like a tail event in workerd, the
 * invocation is not traced itself, so a Worker that tails itself does not loop.
 */
export async function dispatchTail(
	worker: LoopbackWorker,
	records: readonly TraceRecord[],
): Promise<void> {
	const defaultExport = worker.exports.default;
	const controller = createExecutionContext({ exports: worker.contextExports, props: undefined });
	const context = controller.context;
	try {
		await runInExecutionContext(context, async () => {
			const events = records.map(traceItem);
			if (isWorkerEntrypointClass(defaultExport)) {
				const instance: object = Reflect.construct(defaultExport, [context, worker.environment]);
				const tail: unknown = Reflect.get(instance, "tail");
				if (typeof tail !== "function") throw new Error("Handler does not export a tail() function.");
				await Reflect.apply(tail, instance, [events]);
				return;
			}
			const tail: unknown =
				typeof defaultExport === "object" && defaultExport !== null
					? Reflect.get(defaultExport, "tail")
					: undefined;
			if (typeof tail !== "function") throw new Error("Handler does not export a tail() function.");
			await Reflect.apply(tail, defaultExport, [events, worker.environment, context]);
		});
	} finally {
		await controller.drainWaitUntil();
		controller.end();
		releaseExecutionContext(context);
	}
}
