export interface EventInit {
	bubbles?: boolean;
	cancelable?: boolean;
	composed?: boolean;
}

export interface EventValue {
	readonly bubbles: boolean;
	cancelBubble: boolean;
	readonly cancelable: boolean;
	readonly composed: boolean;
	readonly currentTarget: EventTarget | undefined;
	readonly defaultPrevented: boolean;
	readonly eventPhase: number;
	readonly isTrusted: boolean;
	readonly returnValue: boolean;
	readonly srcElement: EventTarget | undefined;
	readonly target: EventTarget | undefined;
	readonly timeStamp: number;
	readonly type: string;
	composedPath(): EventTarget[];
	preventDefault(): void;
	stopImmediatePropagation(): void;
	stopPropagation(): void;
}

export interface EventConstructor {
	readonly prototype: EventValue;
	new (type: string, init?: EventInit): EventValue;
	readonly NONE: number;
	readonly CAPTURING_PHASE: number;
	readonly AT_TARGET: number;
	readonly BUBBLING_PHASE: number;
}

function isEventConstructor(value: unknown): value is EventConstructor {
	if (typeof value !== "function") return false;
	const prototype: unknown = Reflect.get(value, "prototype");
	return (
		typeof prototype === "object" &&
		prototype !== null &&
		typeof Reflect.get(prototype, "preventDefault") === "function" &&
		typeof Reflect.get(prototype, "stopPropagation") === "function"
	);
}

const nativeEvent: unknown = Reflect.get(globalThis, "Event");
if (!isEventConstructor(nativeEvent)) {
	throw new Error("Node.js does not provide the required Event global");
}
const NativeEvent: EventConstructor = nativeEvent;

// Mirrors workerd's Event surface: the timestamp is always zero so it cannot
// serve as a timer, and an absent target reads as undefined.
// https://github.com/cloudflare/workerd/blob/b73ce3ae105c35bafaaad864095079524573a465/src/workerd/api/basics.h#L126-L189
Object.defineProperty(NativeEvent.prototype, "timeStamp", {
	configurable: true,
	enumerable: true,
	get(): number {
		return 0;
	},
});
// Outside pedantic WPT mode, workerd's currentTarget and srcElement both read
// the event's target, which stays set after the dispatch.
const targetGetter = Object.getOwnPropertyDescriptor(NativeEvent.prototype, "target")?.get;
if (targetGetter === undefined) {
	throw new Error("Node.js Event does not define target");
}
for (const name of ["currentTarget", "srcElement", "target"]) {
	const descriptor = Object.getOwnPropertyDescriptor(NativeEvent.prototype, name);
	if (descriptor === undefined) {
		throw new Error(`Node.js Event does not define ${name}`);
	}
	Object.defineProperty(NativeEvent.prototype, name, {
		...descriptor,
		get(this: EventValue): unknown {
			return Reflect.apply(targetGetter, this, []) ?? undefined;
		},
	});
}

// Node clears its dispatch flag after each listener, so later listeners see
// eventPhase NONE and an empty composedPath(). Orange's EventTarget dispatch
// records the events it is dispatching, and the phase and path read that.
// https://github.com/cloudflare/workerd/blob/b73ce3ae105c35bafaaad864095079524573a465/src/workerd/api/basics.c%2B%2B#L61-L96
const dispatchingEvents = new WeakSet<object>();

export function beginEventDispatch(event: object): void {
	dispatchingEvents.add(event);
}

export function endEventDispatch(event: object): void {
	dispatchingEvents.delete(event);
}

export function isEventDispatching(event: object): boolean {
	return dispatchingEvents.has(event);
}

Object.defineProperty(NativeEvent.prototype, "eventPhase", {
	configurable: true,
	enumerable: true,
	get(this: EventValue): number {
		return dispatchingEvents.has(this) ? NativeEvent.AT_TARGET : NativeEvent.NONE;
	},
});
Object.defineProperty(NativeEvent.prototype, "composedPath", {
	configurable: true,
	enumerable: true,
	writable: true,
	value(this: EventValue): unknown[] {
		const target = Reflect.apply(targetGetter, this, []);
		return dispatchingEvents.has(this) && target !== null && target !== undefined
			? [target]
			: [];
	},
});

// workerd's returnValue is readonly, while Node's accepts the legacy setter.
const returnValue = Object.getOwnPropertyDescriptor(NativeEvent.prototype, "returnValue");
if (returnValue !== undefined) {
	Object.defineProperty(NativeEvent.prototype, "returnValue", {
		...returnValue,
		set: undefined,
	});
}

// Orange uses Node's Event itself so Node's CustomEvent, MessageEvent, and
// CloseEvent remain instances of the global Event.
export const Event: EventConstructor = NativeEvent;
export type Event = EventValue;
