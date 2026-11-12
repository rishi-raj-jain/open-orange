import {
	beginEventDispatch,
	endEventDispatch,
	Event,
	isEventDispatching,
	type EventInit,
} from "./event.js";
import { NodeEventTarget, type NodeEventTargetValue as EventTargetValue } from "./node-web.js";

const nodeConsole = globalThis.console;

type ListenerValue = Function | object;
type ListenerOptions = object | boolean;

const NodeAbortSignal = globalThis.AbortSignal;

export interface ErrorEventInit extends EventInit {
	colno?: number;
	error?: unknown;
	filename?: string;
	lineno?: number;
	message?: string;
}

const errorEventInits = new WeakMap<object, ErrorEventInit>();

function errorEventInit(event: object): ErrorEventInit {
	const init = errorEventInits.get(event);
	if (init === undefined) throw new TypeError("Illegal invocation");
	return init;
}

// https://github.com/cloudflare/workerd/blob/b73ce3ae105c35bafaaad864095079524573a465/src/workerd/api/events.h#L121-L158
export class ErrorEvent extends Event {
	constructor(type: string, init: ErrorEventInit = {}) {
		super(type, init);
		errorEventInits.set(this, { ...init });
	}

	get colno(): number {
		return errorEventInit(this).colno ?? 0;
	}

	get error(): unknown {
		return errorEventInit(this).error;
	}

	get filename(): string {
		return errorEventInit(this).filename ?? "";
	}

	get lineno(): number {
		return errorEventInit(this).lineno ?? 0;
	}

	get message(): string {
		return errorEventInit(this).message ?? "";
	}
}

// User code cannot construct this event; the runtime dispatches it for
// unhandled and late-handled promise rejections.
// https://github.com/cloudflare/workerd/blob/b73ce3ae105c35bafaaad864095079524573a465/src/workerd/api/events.h#L169-L187
export class PromiseRejectionEvent extends Event {
	declare readonly promise: Promise<unknown>;
	declare readonly reason: unknown;

	constructor() {
		super("");
		throw new TypeError("Illegal constructor");
	}
}

function createPromiseRejectionEvent(
	type: "rejectionhandled" | "unhandledrejection",
	promise: Promise<unknown>,
	reason: unknown,
): Event {
	const event = new Event(type, { cancelable: true });
	Object.setPrototypeOf(event, PromiseRejectionEvent.prototype);
	markTrusted(event);
	Object.defineProperties(event, {
		promise: { configurable: true, enumerable: true, value: promise },
		reason: { configurable: true, enumerable: true, value: reason },
	});
	return event;
}

// workerd's global scope is an EventTarget. Orange keeps one process-wide
// target and exposes its methods as global functions.
const globalScopeTarget = new NodeEventTarget();

export function addEventListener(
	type: string,
	listener: ListenerValue | null,
	options?: ListenerOptions,
): void {
	globalScopeTarget.addEventListener(type, listener, options);
}

export function removeEventListener(
	type: string,
	listener: ListenerValue | null,
	options?: ListenerOptions,
): void {
	globalScopeTarget.removeEventListener(type, listener, options);
}

export function dispatchEvent(event: Event): boolean {
	return globalScopeTarget.dispatchEvent(event);
}

function logReportedError(error: unknown): void {
	try {
		const stack: unknown =
			typeof error === "object" && error !== null
				? Reflect.get(error, "stack")
				: undefined;
		nodeConsole.error("Uncaught", stack ?? error);
	} catch {
		nodeConsole.error("Uncaught", error);
	}
}

function uncaughtMessage(error: unknown): string {
	try {
		return error instanceof Error
			? `Uncaught ${error.name}: ${error.message}`
			: `Uncaught ${String(error)}`;
	} catch {
		return "Uncaught";
	}
}

// Events that the runtime creates are trusted, unlike user-constructed ones.
function markTrusted(event: Event): void {
	Object.defineProperty(event, "isTrusted", {
		configurable: true,
		enumerable: true,
		value: true,
	});
}

let inErrorReportingMode = false;

// Mirrors workerd's reportError(): dispatch an "error" event on the global
// scope, log when it is not prevented, and never throw. A report raised while
// an "error" listener runs goes straight to the console.
// https://github.com/cloudflare/workerd/blob/b73ce3ae105c35bafaaad864095079524573a465/src/workerd/api/global-scope.c%2B%2B#L1133-L1194
export function reportError(...parameters: unknown[]): void {
	if (parameters.length === 0) {
		throw new TypeError(
			"Failed to execute 'reportError' on 'ServiceWorkerGlobalScope': parameter 1 is not of type 'Value'.",
		);
	}
	const error = parameters[0];
	if (inErrorReportingMode) {
		logReportedError(error);
		return;
	}
	inErrorReportingMode = true;
	try {
		const event = new ErrorEvent("error", { error, message: uncaughtMessage(error) });
		markTrusted(event);
		if (dispatchEvent(event)) logReportedError(error);
	} finally {
		inErrorReportingMode = false;
	}
}

const reportingListeners = new WeakMap<object, ListenerValue>();

// workerd snapshots the listener list when a dispatch starts, so a listener
// added during a dispatch does not see that event. Node's list is live.
// https://github.com/cloudflare/workerd/blob/b73ce3ae105c35bafaaad864095079524573a465/src/workerd/api/basics.c%2B%2B#L369-L410
const eventsInDispatch = new WeakMap<object, Set<object>>();
const skippedEvents = new WeakMap<object, WeakSet<object>>();

function isTrue(value: unknown): boolean {
	return value === true;
}

// workerd supports neither capture nor passive listeners and rejects them.
// https://github.com/cloudflare/workerd/blob/b73ce3ae105c35bafaaad864095079524573a465/src/workerd/api/basics.c%2B%2B#L139-L152
function validateListenerOptions(method: string, options: unknown, add: boolean): void {
	if (typeof options === "boolean") {
		if (options) throw new TypeError(`${method}(): useCapture must be false.`);
		return;
	}
	if (typeof options !== "object" || options === null) return;
	if (isTrue(Reflect.get(options, "capture"))) {
		throw new TypeError(`${method}(): options.capture must be false.`);
	}
	if (add && isTrue(Reflect.get(options, "passive"))) {
		throw new TypeError(`${method}(): options.passive must be false.`);
	}
}

function validateListener(listener: unknown): void {
	if (listener === null || listener === undefined || typeof listener === "function") return;
	if (typeof listener === "object" && typeof Reflect.get(listener, "handleEvent") === "function") {
		return;
	}
	throw new TypeError(
		"Failed to execute 'addEventListener' on 'EventTarget': parameter 2 is not of type 'EventListener'.",
	);
}

interface DispatchErrors {
	error?: unknown;
	threw: boolean;
}

let currentDispatchErrors: DispatchErrors | undefined;

function recordListenerError(error: unknown): void {
	if (currentDispatchErrors !== undefined && !currentDispatchErrors.threw) {
		currentDispatchErrors.threw = true;
		currentDispatchErrors.error = error;
	}
	reportError(error);
}

// Dispatches like workerd's REPORT policy and also returns the first listener
// exception, for APIs that fail fast after a throwing listener.
// https://github.com/cloudflare/workerd/blob/b73ce3ae105c35bafaaad864095079524573a465/src/workerd/api/basics.c%2B%2B#L360-L520
export function dispatchEventCollectingErrors(
	target: { dispatchEvent(event: Event): boolean },
	event: Event,
): DispatchErrors {
	const previous = currentDispatchErrors;
	const errors: DispatchErrors = { threw: false };
	currentDispatchErrors = errors;
	try {
		target.dispatchEvent(event);
	} finally {
		currentDispatchErrors = previous;
	}
	return errors;
}

// workerd reports a throwing listener through reportError() and keeps
// dispatching, while Node rethrows it on the next tick as an uncaught
// exception. Wrap listeners so a throw stays inside the dispatch.
// https://github.com/cloudflare/workerd/blob/b73ce3ae105c35bafaaad864095079524573a465/src/workerd/api/basics.c%2B%2B#L360-L520
function reportingListener(listener: ListenerValue): ListenerValue {
	const existing = reportingListeners.get(listener);
	if (existing !== undefined) return existing;
	const wrapped: ListenerValue =
		typeof listener === "function"
			? function (this: unknown, event: Event): unknown {
					if (skippedEvents.get(wrapped)?.has(event) === true) return undefined;
					try {
						return preventDefaultOnTrue(event, Reflect.apply(listener, this, [event]));
					} catch (error: unknown) {
						recordListenerError(error);
						return undefined;
					}
				}
			: {
					handleEvent(event: Event): unknown {
						if (skippedEvents.get(wrapped)?.has(event) === true) return undefined;
						try {
							const handleEvent: unknown = Reflect.get(listener, "handleEvent");
							if (typeof handleEvent !== "function") {
								throw new TypeError("Event listener object has no handleEvent method");
							}
							return preventDefaultOnTrue(
								event,
								Reflect.apply(handleEvent, listener, [event]),
							);
						} catch (error: unknown) {
							recordListenerError(error);
							return undefined;
						}
					},
				};
	reportingListeners.set(listener, wrapped);
	return wrapped;
}

interface HandlerAttribute {
	handler: unknown;
	readonly listener: (this: EventTargetValue, event: Event) => unknown;
}

const handlerAttributes = new WeakMap<object, Map<string, HandlerAttribute>>();

// Defines an `on<type>` event handler attribute with workerd's semantics: the
// handler keeps the listener position of its first assignment, a non-object
// clears it, and a non-callable object is kept but never invoked.
// https://github.com/cloudflare/workerd/blob/b73ce3ae105c35bafaaad864095079524573a465/src/workerd/api/basics.c%2B%2B#L249-L310
export function defineEventHandlerAttribute(prototype: object, type: string): void {
	const name = `on${type}`;
	const attributes = (target: object): Map<string, HandlerAttribute> => {
		let map = handlerAttributes.get(target);
		if (map === undefined) {
			map = new Map();
			handlerAttributes.set(target, map);
		}
		return map;
	};
	Object.defineProperty(prototype, name, {
		configurable: true,
		enumerable: true,
		get(this: object): unknown {
			return handlerAttributes.get(this)?.get(type)?.handler ?? null;
		},
		set(this: EventTargetValue, handler: unknown): void {
			const map = attributes(this);
			const existing = map.get(type);
			if ((typeof handler !== "object" || handler === null) && typeof handler !== "function") {
				if (existing !== undefined) {
					this.removeEventListener(type, existing.listener);
					map.delete(type);
				}
				return;
			}
			if (existing !== undefined) {
				existing.handler = handler;
				return;
			}
			const attribute: HandlerAttribute = {
				handler,
				listener(this: EventTargetValue, event: Event): unknown {
					const current = attribute.handler;
					return typeof current === "function"
						? Reflect.apply(current, this, [event])
						: undefined;
				},
			};
			map.set(type, attribute);
			this.addEventListener(type, attribute.listener);
		},
	});
}

// A listener that returns true cancels the event, as in workerd.
function preventDefaultOnTrue(event: Event, result: unknown): unknown {
	if (result === true) event.preventDefault();
	return result;
}

interface AbortAlgorithm {
	readonly listener: WeakRef<object>;
	readonly target: WeakRef<EventTargetValue>;
	readonly type: string;
}

// The `{ signal }` listener option registers an abort algorithm, not an
// 'abort' listener: it runs before the abort listeners and only on a real
// abort, never on a synthetic 'abort' event. The algorithm holds the target
// and listener weakly, so a long-lived signal does not retain them.
// https://github.com/cloudflare/workerd/blob/b73ce3ae105c35bafaaad864095079524573a465/src/workerd/api/basics.c%2B%2B#L163-L183
const abortAlgorithms = new WeakMap<object, AbortAlgorithm[]>();

function addAbortAlgorithm(signal: object, algorithm: AbortAlgorithm): void {
	let algorithms = abortAlgorithms.get(signal);
	if (algorithms === undefined) {
		algorithms = [];
		abortAlgorithms.set(signal, algorithms);
	}
	algorithms.push(algorithm);
}

// https://github.com/cloudflare/workerd/blob/b73ce3ae105c35bafaaad864095079524573a465/src/workerd/api/basics.c%2B%2B#L1018-L1040
function runAbortAlgorithms(
	signal: object,
	removeEventListener: EventTargetValue["removeEventListener"],
): void {
	const algorithms = abortAlgorithms.get(signal);
	if (algorithms === undefined) return;
	abortAlgorithms.delete(signal);
	for (const algorithm of algorithms) {
		const target = algorithm.target.deref();
		const listener = algorithm.listener.deref();
		if (target === undefined || listener === undefined) continue;
		Reflect.apply(removeEventListener, target, [algorithm.type, listener]);
	}
}

function hasAccessor(object: object, name: string): boolean {
	for (
		let current: object | null = object;
		current !== null;
		current = Object.getPrototypeOf(current)
	) {
		const descriptor = Object.getOwnPropertyDescriptor(current, name);
		if (descriptor !== undefined) return descriptor.get !== undefined || descriptor.set !== undefined;
	}
	return false;
}

let installed = false;

export function installGlobalScopeEvents(): void {
	if (installed) return;
	installed = true;
	const prototype = NodeEventTarget.prototype;
	const nodeAddEventListener = prototype.addEventListener;
	const nodeRemoveEventListener = prototype.removeEventListener;
	prototype.addEventListener = function (
		this: EventTargetValue,
		type: string,
		listener: ListenerValue | null,
		options?: ListenerOptions,
	): void {
		validateListenerOptions("addEventListener", options, true);
		validateListener(listener);
		const value =
			listener === null || listener === undefined
				? listener
				: reportingListener(listener);
		const inDispatch = eventsInDispatch.get(this);
		if (value !== null && value !== undefined && inDispatch !== undefined) {
			let skipped = skippedEvents.get(value);
			if (skipped === undefined) {
				skipped = new WeakSet();
				skippedEvents.set(value, skipped);
			}
			for (const event of inDispatch) skipped.add(event);
		}
		const signal: unknown =
			typeof options === "object" && options !== null
				? Reflect.get(options, "signal")
				: undefined;
		if (
			signal instanceof NodeAbortSignal &&
			typeof options === "object" &&
			value !== null &&
			value !== undefined
		) {
			if (signal.aborted) return;
			Reflect.apply(nodeAddEventListener, this, [
				type,
				value,
				{ once: Reflect.get(options, "once"), passive: Reflect.get(options, "passive") },
			]);
			addAbortAlgorithm(signal, {
				listener: new WeakRef(value),
				target: new WeakRef(this),
				type,
			});
			return;
		}
		Reflect.apply(nodeAddEventListener, this, [type, value, options]);
	};
	// workerd also calls a plain `on<type>` property before the listeners.
	// Event handler attributes such as AbortSignal's onabort are accessors that
	// already register a listener, so they are skipped here.
	// https://github.com/cloudflare/workerd/blob/b73ce3ae105c35bafaaad864095079524573a465/src/workerd/api/basics.c%2B%2B#L385-L398
	const nodeDispatchEvent = prototype.dispatchEvent;
	prototype.dispatchEvent = function (this: EventTargetValue, event: unknown): boolean {
		if (typeof event !== "object" || event === null) {
			return Reflect.apply(nodeDispatchEvent, this, [event]);
		}
		// Node clears its own guard early when an object listener is present, so
		// Orange tracks dispatching events itself.
		// https://github.com/cloudflare/workerd/blob/b73ce3ae105c35bafaaad864095079524573a465/src/workerd/api/basics.c%2B%2B#L81-L84
		if (isEventDispatching(event)) {
			throw new DOMException("The event is already being dispatched.", "InvalidStateError");
		}
		const type: unknown = Reflect.get(event, "type");
		if (type === "abort" && this instanceof NodeAbortSignal && this.aborted) {
			runAbortAlgorithms(this, nodeRemoveEventListener);
		}
		if (typeof type === "string" && !hasAccessor(this, `on${type}`)) {
			const handler: unknown = Reflect.get(this, `on${type}`);
			const listener = typeof handler === "function" ? reportingListener(handler) : undefined;
			if (typeof listener === "function") Reflect.apply(listener, this, [event]);
		}
		beginEventDispatch(event);
		let inDispatch = eventsInDispatch.get(this);
		if (inDispatch === undefined) {
			inDispatch = new Set();
			eventsInDispatch.set(this, inDispatch);
		}
		inDispatch.add(event);
		try {
			return Reflect.apply(nodeDispatchEvent, this, [event]);
		} finally {
			endEventDispatch(event);
			inDispatch.delete(event);
			if (inDispatch.size === 0) eventsInDispatch.delete(this);
		}
	};
	prototype.removeEventListener = function (
		this: EventTargetValue,
		type: string,
		listener: ListenerValue | null,
		options?: ListenerOptions,
	): void {
		validateListenerOptions("removeEventListener", options, false);
		const value =
			listener === null || listener === undefined
				? listener
				: (reportingListeners.get(listener) ?? listener);
		Reflect.apply(nodeRemoveEventListener, this, [type, value, options]);
	};

	// workerd dispatches unhandled and late-handled rejections as events on the
	// global scope. The late-handled event carries no reason.
	// https://github.com/cloudflare/workerd/blob/b73ce3ae105c35bafaaad864095079524573a465/src/workerd/api/events.h#L169-L187
	process.on("unhandledRejection", (reason: unknown, promise: Promise<unknown>) => {
		dispatchEvent(createPromiseRejectionEvent("unhandledrejection", promise, reason));
	});
	process.on("rejectionHandled", (promise: Promise<unknown>) => {
		dispatchEvent(createPromiseRejectionEvent("rejectionhandled", promise, undefined));
	});
}
