// The user tracing API behind `ctx.tracing` and `cloudflare:workers`. Orange
// has no trace collector, so every request is untraced. For an untraced request
// workerd hands out no-op spans: callbacks still run and return their result,
// and attributes and exceptions are dropped.
// https://github.com/cloudflare/workerd/blob/b73ce3ae105c35bafaaad864095079524573a465/src/workerd/api/tracing.c%2B%2B#L176-L198
// https://github.com/cloudflare/workerd/blob/b73ce3ae105c35bafaaad864095079524573a465/src/workerd/api/tracing.c%2B%2B#L320-L359

type SpanAttributeValue = boolean | number | string;

const spanToken = Symbol("OpenOrangeSpan");

export class Span {
	constructor(token?: symbol) {
		// Workerd gives Span no JavaScript constructor.
		if (token !== spanToken) throw new TypeError("Illegal constructor");
	}

	get isTraced(): boolean {
		return false;
	}

	setAttribute(_key: string, _value?: SpanAttributeValue): this {
		return this;
	}

	setAttributes(
		_attributes: Record<string, SpanAttributeValue | undefined>,
	): this {
		return this;
	}

	recordException(_exception: unknown): void {}

	end(): void {}
}

// Workerd calls the callback with the span followed by the extra arguments.
// https://github.com/cloudflare/workerd/blob/b73ce3ae105c35bafaaad864095079524573a465/src/workerd/api/tracing.c%2B%2B#L376-L400
function runSpan<Result, Args extends unknown[]>(
	method: string,
	callback: (span: Span, ...args: Args) => Result,
	args: Args,
): Result {
	if (typeof callback !== "function") {
		throw new TypeError(
			`Failed to execute '${method}' on 'Tracing': parameter 2 is not of type 'Function'.`,
		);
	}
	return Reflect.apply(callback, globalThis, [new Span(spanToken), ...args]);
}

export class Tracing {
	get Span(): typeof Span {
		return Span;
	}

	enterSpan<Result, Args extends unknown[]>(
		_name: string,
		callback: (span: Span, ...args: Args) => Result,
		...args: Args
	): Result {
		return runSpan("enterSpan", callback, args);
	}

	startActiveSpan<Result, Args extends unknown[]>(
		_name: string,
		callback: (span: Span, ...args: Args) => Result,
		...args: Args
	): Result {
		return runSpan("startActiveSpan", callback, args);
	}

	startSpan(_name: string): Span {
		return new Span(spanToken);
	}
}

export const tracing = new Tracing();
