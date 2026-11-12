import { randomBytes } from "node:crypto";
import { deserialize } from "node:v8";

import {
	isCapnWebRpcStub,
	isCapnWebRpcTarget,
} from "./capnweb.js";
import { isLoopbackStub } from "../../../rpc/loopback.js";
import { isRecord } from "../../unknown-values.js";
import { DurableObjectRpcTarget } from "./target.js";
import {
	decodeRpcExternalTransport,
	encodeRpcExternalTransport,
} from "./stream-transport.js";
import { serializeUnshared } from "../../../internal/v8-serialize.js";

// Workerd caps a serialized RPC value at 32 MiB, a Cloudflare quota that Orange does not copy.
// Rivet's message size bounds a Durable Object call instead (see ./http.ts).

export type RpcValueExternalKind =
	| "blob"
	| "function"
	| "headers"
	| "readable-stream"
	| "request"
	| "response"
	| "rpc-stub"
	| "rpc-target"
	| "writable-stream";

export interface RpcValueExternal {
	readonly kind: RpcValueExternalKind;
	readonly value: object;
}

export interface RpcValueEnvelope {
	readonly externals: readonly RpcValueExternal[];
	readonly v8Serialized: Uint8Array;
}

interface ExtractionContext {
	readonly cloned: WeakMap<object, unknown>;
	readonly externalIndexes: WeakMap<object, number>;
	readonly externalPlaceholders: object[];
	readonly externals: RpcValueExternal[];
	readonly marker: string;
	readonly substitute: RpcValueEncodeOptions["substitute"];
}

export interface RpcValueEncodeOptions {
	// Replaces a value with an RPC target before the value is classified, so a
	// transport can send its own capability wrapper by reference.
	substitute?(value: object): object | undefined;
}

export interface RpcValueDecodeOptions {
	// Turns a received stub or target external into the receiver's value.
	revive?(kind: RpcValueExternalKind, value: object): unknown;
}

const FORMAT ="open-orange-rpc-value-v1";
const FORMAT_KEY = "__openOrangeRpcValueFormat";
const MARKER_KEY = "__openOrangeRpcExternalMarker";
const INDEX_KEY = "__openOrangeRpcExternalIndex";
const VIEW_BUFFER_KEY = "__openOrangeRpcViewBuffer";
const VIEW_BYTE_LENGTH_KEY = "__openOrangeRpcViewByteLength";
const VIEW_BYTE_OFFSET_KEY = "__openOrangeRpcViewByteOffset";
const VIEW_MARKER_KEY = "__openOrangeRpcViewMarker";
const VIEW_TYPE_KEY = "__openOrangeRpcViewType";
const VALUE_KEY = "value";
const ERROR_MARKER_KEY = "__openOrangeRpcErrorMarker";
const ERROR_NAME_KEY = "__openOrangeRpcErrorName";
const ERROR_MESSAGE_KEY = "__openOrangeRpcErrorMessage";
const ERROR_STACK_KEY = "__openOrangeRpcErrorStack";
const ERROR_CAUSE_KEY = "__openOrangeRpcErrorCause";
const ERROR_FIELDS_KEY = "__openOrangeRpcErrorFields";
const ERROR_DOM_EXCEPTION_KEY = "__openOrangeRpcErrorDomException";
const errorFieldsSentSeparately: ReadonlySet<string> = new Set(["cause", "message", "name", "stack"]);

const errorConstructors: ReadonlyMap<string, ErrorConstructor> = new Map([
	["Error", Error],
	["EvalError", EvalError],
	["RangeError", RangeError],
	["ReferenceError", ReferenceError],
	["SyntaxError", SyntaxError],
	["TypeError", TypeError],
	["URIError", URIError],
]);

export function dataCloneError(message: string): DOMException {
	return new DOMException(message, "DataCloneError");
}

function decodeExternalKind(value: unknown): RpcValueExternalKind {
	switch (value) {
		case "blob":
		case "function":
		case "headers":
		case "readable-stream":
		case "request":
		case "response":
		case "rpc-stub":
		case "rpc-target":
		case "writable-stream":
			return value;
		default:
			throw dataCloneError(`Unknown RPC external kind: ${String(value)}`);
	}
}

class LoopbackStubTarget extends DurableObjectRpcTarget {}

// Cap'n Web can't send a stub from a service binding or `ctx.exports`, so the session carries a
// target whose methods call that stub.
function loopbackStubTarget(stub: object): object {
	return new Proxy(new LoopbackStubTarget(), {
		get(target, name, receiver): unknown {
			if (name === Symbol.dispose) {
				return (): void => {
					Reflect.apply(Reflect.get(stub, Symbol.dispose), stub, []);
				};
			}
			if (typeof name !== "string") return Reflect.get(target, name, receiver);
			// Cap'n Web would otherwise treat the target as a promise.
			if (name === "then") return undefined;
			return async (...args: unknown[]): Promise<unknown> => {
				const result: unknown = await Reflect.apply(Reflect.get(stub, name), stub, args);
				return isLoopbackStub(result) ? loopbackStubTarget(result as object) : result;
			};
		},
	});
}

function classifyExternal(value: object): RpcValueExternalKind | undefined {
	if (isCapnWebRpcStub(value)) return "rpc-stub";
	if (
		value instanceof DurableObjectRpcTarget ||
		isCapnWebRpcTarget(value)
	) {
		return "rpc-target";
	}
	if (typeof value === "function") return "function";
	if (value instanceof ReadableStream) return "readable-stream";
	if (value instanceof WritableStream) return "writable-stream";
	if (value instanceof Request) return "request";
	if (value instanceof Response) return "response";
	if (value instanceof Headers) return "headers";
	// workerd serializes a Blob as its type and bytes, but not a File or other
	// subclass, which fail like any unknown class.
	// https://github.com/cloudflare/workerd/blob/7236b3650b6c0951484a4d170f17fb6f800b5662/src/workerd/api/blob.h#L86-L90
	if (Object.getPrototypeOf(value) === Blob.prototype) return "blob";
	return undefined;
}

export function typedViewName(value: ArrayBufferView): string {
	if (value instanceof DataView) return "DataView";
	if (value instanceof Int8Array) return "Int8Array";
	if (value instanceof Uint8Array) return "Uint8Array";
	if (value instanceof Uint8ClampedArray) return "Uint8ClampedArray";
	if (value instanceof Int16Array) return "Int16Array";
	if (value instanceof Uint16Array) return "Uint16Array";
	if (value instanceof Int32Array) return "Int32Array";
	if (value instanceof Uint32Array) return "Uint32Array";
	if (value instanceof Float32Array) return "Float32Array";
	if (value instanceof Float64Array) return "Float64Array";
	if (value instanceof BigInt64Array) return "BigInt64Array";
	if (value instanceof BigUint64Array) return "BigUint64Array";
	throw dataCloneError("Unsupported ArrayBuffer view type");
}

function createTypedViewPlaceholder(
	value: ArrayBufferView,
	context: ExtractionContext,
): object {
	if (!(value.buffer instanceof ArrayBuffer)) {
		throw dataCloneError("SharedArrayBuffer views cannot be sent over Durable Object RPC");
	}
	const placeholder = {
		[VIEW_BUFFER_KEY]: extractValue(value.buffer, context),
		[VIEW_BYTE_LENGTH_KEY]: value.byteLength,
		[VIEW_BYTE_OFFSET_KEY]: value.byteOffset,
		[VIEW_MARKER_KEY]: context.marker,
		[VIEW_TYPE_KEY]: typedViewName(value),
	};
	context.cloned.set(value, placeholder);
	return placeholder;
}

function createExternalPlaceholder(
	value: object,
	kind: RpcValueExternalKind,
	context: ExtractionContext,
	transported: object = value,
): object {
	const previousIndex = context.externalIndexes.get(value);
	if (previousIndex !== undefined) {
		return context.externalPlaceholders[previousIndex];
	}

	const index = context.externals.length;
	const placeholder = {
		[INDEX_KEY]: index,
		[MARKER_KEY]: context.marker,
	};
	context.externalIndexes.set(value, index);
	context.externalPlaceholders.push(placeholder);
	context.externals.push({ kind, value: encodeRpcExternalTransport(kind, transported) });
	return placeholder;
}

function cloneEnumerableProperties(
	source: object,
	target: object,
	context: ExtractionContext,
	excluded: ReadonlySet<string>,
): void {
	// V8 serializes only string keys, so symbol-keyed properties, such as the
	// Symbol.dispose of a received RPC result, are dropped.
	for (const key of Object.keys(source)) {
		if (excluded.has(key)) continue;
		Object.defineProperty(target, key, {
			configurable: true,
			enumerable: true,
			value: extractValue(Reflect.get(source, key), context),
			writable: true,
		});
	}
}

// workerd's enhanced error serialization keeps an error's effective name,
// message, `cause`, and serializable own properties. The caller gets a
// built-in error type, never the thrower's class.
// https://developers.cloudflare.com/workers/runtime-apis/rpc/error-handling/
// V8 alone drops custom names and own properties, so the error travels as a
// placeholder.
function createErrorPlaceholder(value: Error, context: ExtractionContext): object {
	const placeholder: Record<string, unknown> = {
		[ERROR_DOM_EXCEPTION_KEY]: value instanceof DOMException,
		[ERROR_MARKER_KEY]: context.marker,
		[ERROR_MESSAGE_KEY]: String(value.message),
		[ERROR_NAME_KEY]: String(value.name),
		[ERROR_STACK_KEY]: typeof value.stack === "string" ? value.stack : undefined,
	};
	context.cloned.set(value, placeholder);
	if (Object.hasOwn(value, "cause")) {
		placeholder[ERROR_CAUSE_KEY] = extractValue(Reflect.get(value, "cause"), context);
	}
	const fields: Record<string, unknown> = {};
	for (const key of Object.keys(value)) {
		if (errorFieldsSentSeparately.has(key)) continue;
		Object.defineProperty(fields, key, {
			configurable: true,
			enumerable: true,
			value: extractValue(Reflect.get(value, key), context),
			writable: true,
		});
	}
	placeholder[ERROR_FIELDS_KEY] = fields;
	return placeholder;
}

// Cap'n Web sends a thrown error's name and own enumerable fields, but its
// receiver rebuilds only built-in error names, so a custom name rides along as
// a field until `restoreThrownRpcError` puts it back.
// https://github.com/cloudflare/capnweb/blob/766655329fe4fe2dada67c8b4e82e3a81e38b194/src/serialize.ts#L969-L971
const THROWN_ERROR_NAME_KEY = "__openOrangeRpcThrownErrorName";

// An error that the object's own code threw leaves the caller's stub usable, as
// on workerd. A reset or a lost connection breaks the stub. The callee marks the
// first kind with this field, so an unmarked failure still breaks the stub.
// https://github.com/cloudflare/workerd/blob/7236b3650b6c0951484a4d170f17fb6f800b5662/src/workerd/api/tests/js-rpc-test.js#L2257-L2292
const KEEPS_STUB_KEY = "__openOrangeRpcKeepsStub";
const stubBreakingErrors = new WeakSet<object>();
const stubKeepingErrors = new WeakSet<object>();

const resetErrors = new WeakSet<object>();

/** Marks an error the callee raised because the call arrived out of order. */
export function markStubBreakingRpcError(error: unknown): void {
	if (typeof error === "object" && error !== null) stubBreakingErrors.add(error);
}

/**
 * Marks an error that reached the caller because the object reset. It breaks the
 * stub and carries `durableObjectReset: true`, as in workerd.
 * https://github.com/cloudflare/workerd/blob/7236b3650b6c0951484a4d170f17fb6f800b5662/src/workerd/jsg/util.c%2B%2B#L155-L160
 */
export function markDurableObjectResetRpcError(error: unknown): void {
	if (typeof error !== "object" || error === null) return;
	stubBreakingErrors.add(error);
	resetErrors.add(error);
}

/** True when the callee's own code threw `error`, so the caller's stub stays usable. */
export function rpcErrorKeepsStub(error: unknown): boolean {
	return typeof error === "object" && error !== null && stubKeepingErrors.has(error);
}

function copyBuiltInError(error: Error): Error {
	if (error instanceof AggregateError) return new AggregateError(error.errors, error.message);
	const constructor = errorConstructors.get(error.name) ?? Error;
	return new constructor(error.message);
}

// Prepares an error that an RPC method threw for Cap'n Web. The thrower's own
// error object stays unchanged.
export function prepareThrownRpcError(error: unknown): unknown {
	if (!(error instanceof Error)) return error;
	const keepsStub = !stubBreakingErrors.has(error);
	const reset = resetErrors.has(error);
	const builtIn = error.name === "AggregateError" || errorConstructors.has(error.name);
	if (builtIn && !keepsStub && !reset) return error;
	const sent = builtIn ? copyBuiltInError(error) : new Error(error.message);
	for (const key of Object.keys(error)) {
		if (errorFieldsSentSeparately.has(key)) continue;
		Reflect.set(sent, key, Reflect.get(error, key));
	}
	if (Object.hasOwn(error, "cause")) sent.cause = error.cause;
	sent.stack = error.stack;
	if (!builtIn) Reflect.set(sent, THROWN_ERROR_NAME_KEY, error.name);
	if (keepsStub) Reflect.set(sent, KEEPS_STUB_KEY, true);
	if (reset) Reflect.set(sent, "durableObjectReset", true);
	return sent;
}

export function restoreThrownRpcError(error: unknown): void {
	if (!(error instanceof Error)) return;
	if (Object.hasOwn(error, KEEPS_STUB_KEY)) {
		Reflect.deleteProperty(error, KEEPS_STUB_KEY);
		stubKeepingErrors.add(error);
	}
	if (!Object.hasOwn(error, THROWN_ERROR_NAME_KEY)) return;
	const name: unknown = Reflect.get(error, THROWN_ERROR_NAME_KEY);
	Reflect.deleteProperty(error, THROWN_ERROR_NAME_KEY);
	if (typeof name !== "string") return;
	Object.defineProperty(error, "name", {
		configurable: true,
		enumerable: false,
		value: name,
		writable: true,
	});
}

// A Durable Object fetch() that throws rejects the caller's fetch() with the
// error, as in workerd, instead of answering with a response. The error travels
// as JSON in a response that only Orange's caller reads.
export function serializeThrownFetchError(error: unknown): string {
	const sent = prepareThrownRpcError(error);
	if (!(sent instanceof Error)) {
		return JSON.stringify({ fields: {}, message: String(sent), name: "Error" });
	}
	const fields: Record<string, unknown> = {};
	for (const key of Object.keys(sent)) {
		if (errorFieldsSentSeparately.has(key)) continue;
		fields[key] = Reflect.get(sent, key);
	}
	return JSON.stringify({ fields, message: sent.message, name: sent.name }, (_key, value: unknown) =>
		typeof value === "bigint" || typeof value === "function" || typeof value === "symbol"
			? undefined
			: value,
	);
}

export function deserializeThrownFetchError(text: string): Error {
	const value: unknown = JSON.parse(text);
	const name: unknown = isRecord(value) ? value.name : undefined;
	const message: unknown = isRecord(value) ? value.message : undefined;
	const fields: unknown = isRecord(value) ? value.fields : undefined;
	if (typeof name !== "string" || typeof message !== "string" || !isRecord(fields)) {
		throw new TypeError("Durable Object fetch error is invalid");
	}
	const error = new (errorConstructors.get(name) ?? Error)(message);
	for (const [key, field] of Object.entries(fields)) Reflect.set(error, key, field);
	restoreThrownRpcError(error);
	return error;
}

function extractValue(value: unknown, context: ExtractionContext): unknown {
	if (
		value === null ||
		typeof value === "undefined" ||
		typeof value === "boolean" ||
		typeof value === "number" ||
		typeof value === "bigint" ||
		typeof value === "string"
	) {
		return value;
	}
	if (typeof value === "symbol") {
		// V8's message, which workerd surfaces.
		throw dataCloneError(`${String(value)} could not be cloned.`);
	}
	if (typeof value !== "object" && typeof value !== "function") {
		throw dataCloneError(`Unsupported RPC value type: ${typeof value}`);
	}

	const previousIndex = context.externalIndexes.get(value);
	if (previousIndex !== undefined) return context.externalPlaceholders[previousIndex];
	const substituted = context.substitute?.(value) ?? (isLoopbackStub(value) ? loopbackStubTarget(value) : undefined);
	if (substituted !== undefined) {
		return createExternalPlaceholder(value, "rpc-target", context, substituted);
	}
	const externalKind = classifyExternal(value);
	if (externalKind !== undefined) {
		return createExternalPlaceholder(value, externalKind, context);
	}

	const previous = context.cloned.get(value);
	if (previous !== undefined) return previous;

	if (value instanceof Error) return createErrorPlaceholder(value, context);
	// V8 serializes these itself, including boxed primitives.
	if (
		value instanceof Date ||
		value instanceof RegExp ||
		value instanceof ArrayBuffer ||
		value instanceof Boolean ||
		value instanceof Number ||
		value instanceof String ||
		value instanceof BigInt
	) {
		context.cloned.set(value, value);
		return value;
	}
	if (ArrayBuffer.isView(value)) {
		return createTypedViewPlaceholder(value, context);
	}
	if (value instanceof SharedArrayBuffer) {
		throw dataCloneError("SharedArrayBuffer cannot be sent over Durable Object RPC");
	}
	if (Array.isArray(value)) {
		const clone: unknown[] = new Array(value.length);
		context.cloned.set(value, clone);
		cloneEnumerableProperties(value, clone, context, new Set(["length"]));
		return clone;
	}
	if (value instanceof Map) {
		const clone = new Map<unknown, unknown>();
		context.cloned.set(value, clone);
		for (const [key, entry] of value) {
			clone.set(extractValue(key, context), extractValue(entry, context));
		}
		return clone;
	}
	if (value instanceof Set) {
		const clone = new Set<unknown>();
		context.cloned.set(value, clone);
		for (const entry of value) clone.add(extractValue(entry, context));
		return clone;
	}

	if (value instanceof AbortSignal) {
		// workerd's message while its enable_abortsignal_rpc flag is off.
		// https://github.com/cloudflare/workerd/blob/7236b3650b6c0951484a4d170f17fb6f800b5662/src/workerd/api/basics.c%2B%2B#L1134-L1136
		throw dataCloneError("AbortSignal serialization is not enabled.");
	}
	if (value instanceof WeakMap || value instanceof WeakSet || value instanceof WeakRef) {
		// V8's message for its own uncloneable objects, which workerd surfaces.
		throw dataCloneError(`#<${value.constructor.name}> could not be cloned.`);
	}
	const prototype: unknown = Object.getPrototypeOf(value);
	if (prototype !== Object.prototype && prototype !== null) {
		const constructorName = Reflect.get(value, "constructor");
		const name =
			typeof constructorName === "function" && constructorName.name !== ""
				? constructorName.name
				: "unknown";
		// https://github.com/cloudflare/workerd/blob/7236b3650b6c0951484a4d170f17fb6f800b5662/src/workerd/jsg/ser.c%2B%2B#L186-L195
		throw dataCloneError(
			`Could not serialize object of type "${name}". This type does not support serialization.`,
		);
	}
	const clone: object = prototype === null ? Object.create(null) : {};
	context.cloned.set(value, clone);
	cloneEnumerableProperties(value, clone, context, new Set());
	return clone;
}

export function decodeRpcExternals(externals: unknown): readonly RpcValueExternal[] {
	if (!Array.isArray(externals)) {
		throw dataCloneError("RPC external table is not an array");
	}
	const decoded: RpcValueExternal[] = [];
	for (const external of externals) {
		if (typeof external !== "object" || external === null) {
			throw dataCloneError("RPC external table contains an invalid entry");
		}
		const kind = decodeExternalKind(Reflect.get(external, "kind"));
		const value: unknown = Reflect.get(external, "value");
		if (
			(typeof value !== "object" || value === null) &&
			typeof value !== "function"
		) {
			throw dataCloneError("RPC external table contains a non-object value");
		}
		decoded.push({ kind, value: decodeRpcExternalTransport(kind, value) });
	}
	return decoded;
}

function readPlaceholderIndex(value: object, marker: string): number | undefined {
	const prototype: unknown = Object.getPrototypeOf(value);
	if (prototype !== Object.prototype && prototype !== null) return undefined;
	const keys = Object.keys(value);
	if (
		keys.length !== 2 ||
		!keys.includes(INDEX_KEY) ||
		!keys.includes(MARKER_KEY) ||
		Reflect.get(value, MARKER_KEY) !== marker
	) {
		return undefined;
	}
	const index: unknown = Reflect.get(value, INDEX_KEY);
	if (typeof index !== "number" || !Number.isSafeInteger(index) || index < 0) {
		throw dataCloneError("RPC value contains an invalid external index");
	}
	return index;
}

export function createTypedView(
	type: string,
	buffer: ArrayBuffer,
	byteOffset: number,
	byteLength: number,
): ArrayBufferView {
	try {
		switch (type) {
			case "DataView":
				return new DataView(buffer, byteOffset, byteLength);
			case "Int8Array":
				return new Int8Array(buffer, byteOffset, byteLength);
			case "Uint8Array":
				return new Uint8Array(buffer, byteOffset, byteLength);
			case "Uint8ClampedArray":
				return new Uint8ClampedArray(buffer, byteOffset, byteLength);
			case "Int16Array":
				return new Int16Array(buffer, byteOffset, byteLength / 2);
			case "Uint16Array":
				return new Uint16Array(buffer, byteOffset, byteLength / 2);
			case "Int32Array":
				return new Int32Array(buffer, byteOffset, byteLength / 4);
			case "Uint32Array":
				return new Uint32Array(buffer, byteOffset, byteLength / 4);
			case "Float32Array":
				return new Float32Array(buffer, byteOffset, byteLength / 4);
			case "Float64Array":
				return new Float64Array(buffer, byteOffset, byteLength / 8);
			case "BigInt64Array":
				return new BigInt64Array(buffer, byteOffset, byteLength / 8);
			case "BigUint64Array":
				return new BigUint64Array(buffer, byteOffset, byteLength / 8);
			default:
				throw dataCloneError(`Unknown RPC typed view: ${type}`);
		}
	} catch (error) {
		if (error instanceof DOMException) throw error;
		throw dataCloneError(`Invalid RPC typed view: ${type}`);
	}
}

function hydrateTypedView(
	value: object,
	marker: string,
	externals: readonly RpcValueExternal[],
	used: Set<number>,
	hydrated: WeakMap<object, object>,
): ArrayBufferView | undefined {
	if (Reflect.get(value, VIEW_MARKER_KEY) !== marker) return undefined;
	const type: unknown = Reflect.get(value, VIEW_TYPE_KEY);
	const byteOffset: unknown = Reflect.get(value, VIEW_BYTE_OFFSET_KEY);
	const byteLength: unknown = Reflect.get(value, VIEW_BYTE_LENGTH_KEY);
	if (
		typeof type !== "string" ||
		typeof byteOffset !== "number" ||
		!Number.isSafeInteger(byteOffset) ||
		byteOffset < 0 ||
		typeof byteLength !== "number" ||
		!Number.isSafeInteger(byteLength) ||
		byteLength < 0
	) {
		throw dataCloneError("RPC value contains an invalid typed view descriptor");
	}
	const buffer = hydrateValue(
		Reflect.get(value, VIEW_BUFFER_KEY),
		marker,
		externals,
		used,
		hydrated,
	);
	if (!(buffer instanceof ArrayBuffer)) {
		throw dataCloneError("RPC typed view does not reference an ArrayBuffer");
	}
	const view = createTypedView(type, buffer, byteOffset, byteLength);
	if (view.byteOffset !== byteOffset || view.byteLength !== byteLength) {
		throw dataCloneError("RPC typed view has invalid alignment or length");
	}
	hydrated.set(value, view);
	return view;
}

function hydrateError(
	value: object,
	marker: string,
	externals: readonly RpcValueExternal[],
	used: Set<number>,
	hydrated: WeakMap<object, object>,
): Error | undefined {
	if (Reflect.get(value, ERROR_MARKER_KEY) !== marker) return undefined;
	const name: unknown = Reflect.get(value, ERROR_NAME_KEY);
	const message: unknown = Reflect.get(value, ERROR_MESSAGE_KEY);
	const stack: unknown = Reflect.get(value, ERROR_STACK_KEY);
	const fields: unknown = Reflect.get(value, ERROR_FIELDS_KEY);
	if (
		typeof name !== "string" ||
		typeof message !== "string" ||
		(stack !== undefined && typeof stack !== "string") ||
		typeof fields !== "object" ||
		fields === null
	) {
		throw dataCloneError("RPC value contains an invalid error");
	}
	// workerd serializes DOMException as its own type, so its name and code survive.
	// https://github.com/cloudflare/workerd/blob/7236b3650b6c0951484a4d170f17fb6f800b5662/src/workerd/jsg/dom-exception.h#L96-L101
	const error =
		Reflect.get(value, ERROR_DOM_EXCEPTION_KEY) === true
			? new DOMException(message, name)
			: new (errorConstructors.get(name) ?? Error)(message);
	if (error.name !== name) {
		Object.defineProperty(error, "name", {
			configurable: true,
			enumerable: false,
			value: name,
			writable: true,
		});
	}
	if (stack === undefined) Reflect.deleteProperty(error, "stack");
	else error.stack = stack;
	hydrated.set(value, error);
	if (Object.hasOwn(value, ERROR_CAUSE_KEY)) {
		Object.defineProperty(error, "cause", {
			configurable: true,
			enumerable: false,
			value: hydrateValue(Reflect.get(value, ERROR_CAUSE_KEY), marker, externals, used, hydrated),
			writable: true,
		});
	}
	for (const key of Object.keys(fields)) {
		Object.defineProperty(error, key, {
			configurable: true,
			enumerable: true,
			value: hydrateValue(Reflect.get(fields, key), marker, externals, used, hydrated),
			writable: true,
		});
	}
	return error;
}

function hydrateValue(
	value: unknown,
	marker: string,
	externals: readonly RpcValueExternal[],
	used: Set<number>,
	hydrated: WeakMap<object, object>,
): unknown {
	if (
		(typeof value !== "object" || value === null) &&
		typeof value !== "function"
	) {
		return value;
	}
	const externalIndex = readPlaceholderIndex(value, marker);
	if (externalIndex !== undefined) {
		const external = externals[externalIndex];
		if (external === undefined) {
			throw dataCloneError("RPC value references a missing external");
		}
		used.add(externalIndex);
		return external.value;
	}
	const previous = hydrated.get(value);
	if (previous !== undefined) return previous;
	const typedView = hydrateTypedView(value, marker, externals, used, hydrated);
	if (typedView !== undefined) return typedView;
	const error = hydrateError(value, marker, externals, used, hydrated);
	if (error !== undefined) return error;
	hydrated.set(value, value);

	if (value instanceof Map) {
		const entries: [unknown, unknown][] = [];
		for (const [key, entry] of value) {
			entries.push([
				hydrateValue(key, marker, externals, used, hydrated),
				hydrateValue(entry, marker, externals, used, hydrated),
			]);
		}
		value.clear();
		for (const [key, entry] of entries) value.set(key, entry);
		return value;
	}
	if (value instanceof Set) {
		const entries: unknown[] = [];
		for (const entry of value) {
			entries.push(hydrateValue(entry, marker, externals, used, hydrated));
		}
		value.clear();
		for (const entry of entries) value.add(entry);
		return value;
	}
	if (
		value instanceof Date ||
		value instanceof RegExp ||
		value instanceof Error ||
		value instanceof Boolean ||
		value instanceof Number ||
		value instanceof String ||
		value instanceof BigInt ||
		value instanceof ArrayBuffer ||
		value instanceof SharedArrayBuffer ||
		ArrayBuffer.isView(value)
	) {
		return value;
	}
	for (const key of Object.keys(value)) {
		Reflect.set(
			value,
			key,
			hydrateValue(Reflect.get(value, key), marker, externals, used, hydrated),
		);
	}
	return value;
}

function deserializeEnvelope(v8Serialized: Uint8Array): object {
	let decoded: unknown;
	try {
		decoded = deserialize(v8Serialized);
	} catch {
		throw dataCloneError("RPC value contains invalid V8 serialized data");
	}
	if (typeof decoded !== "object" || decoded === null) {
		throw dataCloneError("RPC value envelope is invalid");
	}
	return decoded;
}

// Splits a value into a cloneable graph and its external table. The graph
// holds only plain data, Map, Set, Date, RegExp, and ArrayBuffer, so a
// transport may serialize it with any codec that round-trips those.
export function extractRpcGraph(
	value: unknown,
	options: RpcValueEncodeOptions = {},
): { readonly externals: RpcValueExternal[]; readonly graph: object } {
	const context: ExtractionContext = {
		cloned: new WeakMap(),
		externalIndexes: new WeakMap(),
		externalPlaceholders: [],
		externals: [],
		marker: randomBytes(16).toString("hex"),
		substitute: options.substitute,
	};
	const graph = {
		[FORMAT_KEY]: FORMAT,
		[MARKER_KEY]: context.marker,
		[VALUE_KEY]: extractValue(value, context),
	};
	return { externals: context.externals, graph };
}

export function encodeRpcValue(
	value: unknown,
	options: RpcValueEncodeOptions = {},
): RpcValueEnvelope {
	const { externals, graph } = extractRpcGraph(value, options);
	let v8Serialized: Uint8Array;
	try {
		v8Serialized = serializeUnshared(graph);
	} catch {
		throw dataCloneError("RPC value could not be serialized by V8");
	}
	return { externals, v8Serialized };
}

function decodeEnvelopeFields(envelope: unknown): {
	externals: readonly RpcValueExternal[];
	v8Serialized: Uint8Array;
} {
	if (typeof envelope !== "object" || envelope === null) {
		throw dataCloneError("RPC value envelope is not an object");
	}
	const externals = decodeRpcExternals(Reflect.get(envelope, "externals"));
	const v8Serialized: unknown = Reflect.get(envelope, "v8Serialized");
	if (!(v8Serialized instanceof Uint8Array)) {
		throw dataCloneError("RPC value envelope has no V8 byte payload");
	}
	return { externals, v8Serialized };
}

function isRevivedObject(value: unknown): value is object {
	return (typeof value === "object" && value !== null) || typeof value === "function";
}

export function getRpcValueExternalCount(envelope: unknown): number {
	return decodeEnvelopeFields(envelope).externals.length;
}

async function disposeExternal(external: RpcValueExternal): Promise<void> {
	const asyncDispose = Reflect.get(external.value, Symbol.asyncDispose);
	if (typeof asyncDispose === "function") {
		await Reflect.apply(asyncDispose, external.value, []);
		return;
	}
	const dispose = Reflect.get(external.value, Symbol.dispose);
	if (typeof dispose === "function") {
		await Reflect.apply(dispose, external.value, []);
		return;
	}
	if (external.value instanceof ReadableStream) {
		if (!external.value.locked) {
			await external.value.cancel(
				new Error("Durable Object RPC value was released before transfer"),
			);
		}
		return;
	}
	if (external.value instanceof WritableStream) {
		if (!external.value.locked) {
			await external.value.abort(
				new Error("Durable Object RPC value was released before transfer"),
			);
		}
		return;
	}
	if (
		(external.value instanceof Request ||
			external.value instanceof Response) &&
		external.value.body !== null &&
		!external.value.body.locked
	) {
		await external.value.body.cancel(
			new Error("Durable Object RPC value was released before transfer"),
		);
	}
}

export async function disposeRpcValueExternals(
	envelope: RpcValueEnvelope,
): Promise<void> {
	const results = await Promise.allSettled(
		envelope.externals.map((external) => disposeExternal(external)),
	);
	const failures: unknown[] = [];
	for (const result of results) {
		if (result.status === "rejected") failures.push(result.reason);
	}
	if (failures.length !== 0) {
		throw new AggregateError(failures, "Failed to release Durable Object RPC externals");
	}
}

export function decodeRpcValue(
	envelope: unknown,
	options: RpcValueDecodeOptions = {},
): unknown {
	const fields = decodeEnvelopeFields(envelope);
	return hydrateRpcGraph(deserializeEnvelope(fields.v8Serialized), fields.externals, options);
}

// Restores a value from a graph made by `extractRpcGraph` after the transport
// decoded it. `externals` must already be validated with `decodeRpcExternals`.
export function hydrateRpcGraph(
	graph: object,
	rawExternals: readonly RpcValueExternal[],
	options: RpcValueDecodeOptions = {},
): unknown {
	const revive = options.revive;
	const externals =
		revive === undefined
			? rawExternals
			: rawExternals.map((external) => {
					if (external.kind !== "rpc-stub" && external.kind !== "rpc-target") return external;
					const revived = revive(external.kind, external.value);
					return isRevivedObject(revived) ? { kind: external.kind, value: revived } : external;
				});
	if (Reflect.get(graph, FORMAT_KEY) !== FORMAT) {
		throw dataCloneError("RPC value envelope has an unsupported format");
	}
	if (!Object.hasOwn(graph, VALUE_KEY)) {
		throw dataCloneError("RPC value envelope has no value");
	}
	const marker: unknown = Reflect.get(graph, MARKER_KEY);
	if (typeof marker !== "string" || marker.length !== 32) {
		throw dataCloneError("RPC value envelope has an invalid external marker");
	}
	const used = new Set<number>();
	const value = hydrateValue(
		Reflect.get(graph, VALUE_KEY),
		marker,
		externals,
		used,
		new WeakMap(),
	);
	if (used.size !== externals.length) {
		throw dataCloneError("RPC value did not consume its complete external table");
	}
	return value;
}

// workerd serializes an ordinary V8 graph plus an ordered external table and
// requires the decoder to consume every external. Orange mirrors that envelope,
// with Cap'n Web carrying the table entries between Node runtimes.
// https://github.com/cloudflare/workerd/blob/dc27e996c4ab8e8849cc6229ae816b3d426f08ef/src/workerd/api/worker-rpc.c%2B%2B#L167-L245
// https://github.com/cloudflare/workerd/blob/dc27e996c4ab8e8849cc6229ae816b3d426f08ef/src/workerd/io/worker-interface.capnp#L562-L668
// The accepted values intentionally follow Workers Rpc.Serializable rather
// than Cap'n Web's broader value set.
// https://github.com/cloudflare/workerd/blob/dc27e996c4ab8e8849cc6229ae816b3d426f08ef/types/defines/rpc.d.ts#L35-L120
