// Capture compatible Node.js web-platform globals before the Cloudflare global
// installer replaces the process-wide properties.
import { reportError } from "./global-scope.js";
import { installNodePolyfills } from "./node-polyfills.js";
import "./stream-compat.js";
import { workerdBlobConstructor, workerdStreamConstructor } from "./web-compat.js";

installNodePolyfills();

const NativeAbortController = globalThis.AbortController;
const NativeAbortSignal = globalThis.AbortSignal;
const nodeConsole = globalThis.console;

export interface DOMExceptionConstructor {
	readonly prototype: DOMException;
	new (message?: string, name?: string): DOMException;
	isError(value: unknown): value is Error;
	readonly ABORT_ERR: number;
	readonly DATA_CLONE_ERR: number;
	readonly DOMSTRING_SIZE_ERR: number;
	readonly HIERARCHY_REQUEST_ERR: number;
	readonly INDEX_SIZE_ERR: number;
	readonly INUSE_ATTRIBUTE_ERR: number;
	readonly INVALID_ACCESS_ERR: number;
	readonly INVALID_CHARACTER_ERR: number;
	readonly INVALID_MODIFICATION_ERR: number;
	readonly INVALID_NODE_TYPE_ERR: number;
	readonly INVALID_STATE_ERR: number;
	readonly NAMESPACE_ERR: number;
	readonly NETWORK_ERR: number;
	readonly NO_DATA_ALLOWED_ERR: number;
	readonly NO_MODIFICATION_ALLOWED_ERR: number;
	readonly NOT_FOUND_ERR: number;
	readonly NOT_SUPPORTED_ERR: number;
	readonly QUOTA_EXCEEDED_ERR: number;
	readonly SECURITY_ERR: number;
	readonly SYNTAX_ERR: number;
	readonly TIMEOUT_ERR: number;
	readonly TYPE_MISMATCH_ERR: number;
	readonly URL_MISMATCH_ERR: number;
	readonly VALIDATION_ERR: number;
	readonly WRONG_DOCUMENT_ERR: number;
}

function isDOMExceptionConstructor(value: unknown): value is DOMExceptionConstructor {
	return (
		typeof value === "function" &&
		typeof Reflect.get(value, "isError") === "function" &&
		typeof Reflect.get(value, "prototype") === "object"
	);
}

const maybeNativeDOMException: unknown = globalThis.DOMException;
if (typeof maybeNativeDOMException !== "function") {
	throw new Error("Node.js does not provide the required DOMException global");
}
if (typeof Reflect.get(maybeNativeDOMException, "isError") !== "function") {
	Reflect.defineProperty(maybeNativeDOMException, "isError", {
		configurable: true,
		value: Error.isError,
	});
}
if (!isDOMExceptionConstructor(maybeNativeDOMException)) {
	throw new Error("Node.js does not provide the required DOMException global");
}
const NativeDOMException = maybeNativeDOMException;

export interface BlobConstructor {
	readonly prototype: Blob;
	new (bits?: unknown[], options?: object): Blob;
}

export interface ReadableStreamConstructor {
	readonly prototype: ReadableStream;
	new (
		underlyingSource: object,
		strategy?: object,
	): ReadableStream<Uint8Array>;
	new <R = unknown>(
		underlyingSource?: object,
		strategy?: object,
	): ReadableStream<R>;
}

export interface TransformStreamConstructor {
	readonly prototype: TransformStream;
	new <I = unknown, O = unknown>(
		transformer?: object,
		writableStrategy?: object,
		readableStrategy?: object,
	): TransformStream<I, O>;
}

export interface WritableStreamConstructor {
	readonly prototype: WritableStream;
	new <W = unknown>(
		underlyingSink?: object,
		strategy?: object,
	): WritableStream<W>;
}

export interface PerformanceValue {
	readonly timeOrigin: number;
	now(): number;
	toJSON(): object;
}

function hasPrototypeMethods(value: unknown, methods: string[]): boolean {
	if (typeof value !== "function") return false;
	const prototype: unknown = Reflect.get(value, "prototype");
	return (
		typeof prototype === "object" &&
		prototype !== null &&
		methods.every((method) => typeof Reflect.get(prototype, method) === "function")
	);
}

function isBlobConstructor(value: unknown): value is BlobConstructor {
	return hasPrototypeMethods(value, ["arrayBuffer", "slice", "stream", "text"]);
}

function isTransformStreamConstructor(
	value: unknown,
): value is TransformStreamConstructor {
	return hasPrototypeMethods(value, []);
}

function isWritableStreamConstructor(
	value: unknown,
): value is WritableStreamConstructor {
	return hasPrototypeMethods(value, ["abort", "close", "getWriter"]);
}

function isReadableStreamConstructor(
	value: unknown,
): value is ReadableStreamConstructor {
	if (typeof value !== "function") {
		return false;
	}
	const prototype: unknown = Reflect.get(value, "prototype");
	return (
		typeof prototype === "object" &&
		prototype !== null &&
		typeof Reflect.get(prototype, "cancel") === "function" &&
		typeof Reflect.get(prototype, "getReader") === "function"
	);
}

const maybeNativeReadableStream: unknown = globalThis.ReadableStream;
if (!isReadableStreamConstructor(maybeNativeReadableStream)) {
	throw new Error("Node.js does not provide the required ReadableStream global");
}
const NativeReadableStream = maybeNativeReadableStream;

// Workerd gives a byte stream a 4096-byte autoAllocateChunkSize unless its
// source sets one, so default reads still expose controller.byobRequest.
// https://github.com/cloudflare/workerd/blob/b73ce3ae105c35bafaaad864095079524573a465/src/workerd/api/streams/standard.c%2B%2B#L3159-L3183
const defaultAutoAllocateChunkSize = 4096;

function withDefaultAutoAllocateChunkSize(source: unknown): unknown {
	if (
		typeof source !== "object" ||
		source === null ||
		String(Reflect.get(source, "type")) !== "bytes" ||
		Reflect.get(source, "autoAllocateChunkSize") !== undefined
	) {
		return source;
	}
	const bound = (name: string): unknown => {
		const method: unknown = Reflect.get(source, name);
		return typeof method === "function" ? method.bind(source) : method;
	};
	return {
		autoAllocateChunkSize: defaultAutoAllocateChunkSize,
		cancel: bound("cancel"),
		pull: bound("pull"),
		start: bound("start"),
		type: "bytes",
	};
}

// A constructor function that shares the native prototype keeps instanceof
// and prototype checks working for streams that Node creates internally.
function WorkersReadableStream(
	this: unknown,
	underlyingSource?: object,
	strategy?: object,
): ReadableStream {
	if (new.target === undefined) {
		throw new TypeError("Class constructor ReadableStream cannot be invoked without 'new'");
	}
	return Reflect.construct(
		NativeReadableStream,
		[withDefaultAutoAllocateChunkSize(underlyingSource), strategy],
		new.target,
	);
}
Object.defineProperty(WorkersReadableStream, "name", { value: "ReadableStream" });
Object.defineProperty(WorkersReadableStream, "prototype", {
	value: NativeReadableStream.prototype,
	writable: false,
});
Object.setPrototypeOf(WorkersReadableStream, NativeReadableStream);
const maybeReadableStreamGlobal: unknown = WorkersReadableStream;
if (!isReadableStreamConstructor(maybeReadableStreamGlobal)) {
	throw new Error("OpenOrange could not wrap the ReadableStream global");
}
const ReadableStreamGlobal = maybeReadableStreamGlobal;

const maybeNativeBlob: unknown = Reflect.get(globalThis, "Blob");
if (!isBlobConstructor(maybeNativeBlob)) {
	throw new Error("Node.js does not provide the required Blob global");
}
const NativeBlob = maybeNativeBlob;

const maybeNativeTransformStream: unknown = Reflect.get(
	globalThis,
	"TransformStream",
);
if (!isTransformStreamConstructor(maybeNativeTransformStream)) {
	throw new Error("Node.js does not provide the required TransformStream global");
}
const NativeTransformStream: TransformStreamConstructor =
	maybeNativeTransformStream;

const maybeNativeWritableStream: unknown = Reflect.get(
	globalThis,
	"WritableStream",
);
if (!isWritableStreamConstructor(maybeNativeWritableStream)) {
	throw new Error("Node.js does not provide the required WritableStream global");
}
const NativeWritableStream: WritableStreamConstructor = maybeNativeWritableStream;

function isPerformance(value: unknown): value is PerformanceValue {
	return (
		typeof value === "object" &&
		value !== null &&
		typeof Reflect.get(value, "timeOrigin") === "number" &&
		typeof Reflect.get(value, "now") === "function" &&
		typeof Reflect.get(value, "toJSON") === "function"
	);
}

const maybeNodePerformance: unknown = Reflect.get(globalThis, "performance");
if (!isPerformance(maybeNodePerformance)) {
	throw new Error("Node.js does not provide the required performance global");
}
const nodePerformance = maybeNodePerformance;
const nodeQueueMicrotask = globalThis.queueMicrotask;
const nodeStructuredClone = globalThis.structuredClone;

export const Blob = workerdBlobConstructor(NativeBlob);
export const ReadableStream = workerdStreamConstructor(
	ReadableStreamGlobal,
	"readable",
);
export const TransformStream = workerdStreamConstructor(
	NativeTransformStream,
	"transform",
);
export const WritableStream = workerdStreamConstructor(
	NativeWritableStream,
	"writable",
);

// workerd validates the callback eagerly and reports a throwing microtask
// through reportError() instead of failing the process.
// https://github.com/cloudflare/workerd/blob/b73ce3ae105c35bafaaad864095079524573a465/src/workerd/api/global-scope.c%2B%2B#L1016-L1051
export function queueMicrotask(task: Function): void {
	if (typeof task !== "function") {
		throw new TypeError(
			"Failed to execute 'queueMicrotask' on 'ServiceWorkerGlobalScope': parameter 1 is not of type 'function'.",
		);
	}
	nodeQueueMicrotask(() => {
		try {
			Reflect.apply(task, undefined, []);
		} catch (error: unknown) {
			reportError(error);
		}
	});
}

// workerd's PerformanceMark and PerformanceMeasure omit `detail` from toJSON()
// when none was given. Node.js always includes it as null.
// https://github.com/cloudflare/workerd/blob/b73ce3ae105c35bafaaad864095079524573a465/src/workerd/api/performance.c%2B%2B#L28-L40
let performanceEntryJsonInstalled = false;

export function installPerformanceEntryJson(): void {
	if (performanceEntryJsonInstalled) return;
	performanceEntryJsonInstalled = true;
	for (const name of ["PerformanceMark", "PerformanceMeasure"]) {
		const entry: unknown = Reflect.get(globalThis, name);
		const prototype: unknown =
			typeof entry === "function" ? Reflect.get(entry, "prototype") : undefined;
		if (typeof prototype !== "object" || prototype === null) continue;
		const nodeToJSON: unknown = Reflect.get(prototype, "toJSON");
		if (typeof nodeToJSON !== "function") continue;
		Object.defineProperty(prototype, "toJSON", {
			configurable: true,
			enumerable: false,
			writable: true,
			value: function toJSON(this: object): unknown {
				const json: unknown = Reflect.apply(nodeToJSON, this, []);
				if (
					typeof json === "object" &&
					json !== null &&
					Reflect.get(json, "detail") == null
				) {
					Reflect.deleteProperty(json, "detail");
				}
				return json;
			},
		});
	}
}

export {
	NativeAbortController as AbortController,
	NativeAbortSignal as AbortSignal,
	NativeDOMException as DOMException,
	nodeConsole as console,
	nodePerformance as performance,
	nodeStructuredClone as structuredClone,
};
