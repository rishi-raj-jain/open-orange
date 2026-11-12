import { isNativeError } from "node:util/types";

import { TextDecoder, TextEncoder } from "./encoding.js";
import { Headers, Request, Response } from "./http.js";
import { structuredClone as nodeStructuredClone } from "./native.js";
import { nodeWebGlobals } from "./node-web.js";

// Platform objects that workerd's serializer rejects. File is checked before
// Node's structured clone, which would otherwise accept it.
const nonSerializableTypes: readonly [Function, string][] = [
	[nodeWebGlobals.File, "File"],
	[Response, "Response"],
	[TextDecoder, "TextDecoder"],
	[TextEncoder, "TextEncoder"],
];

// Mirrors workerd's structuredClone(): Headers round-trip, unsupported
// platform objects fail with DataCloneError, and a repeated transfer entry is
// accepted.
// https://github.com/cloudflare/workerd/blob/b73ce3ae105c35bafaaad864095079524573a465/src/workerd/api/tests/global-scope-test.js#L214-L352
export function structuredClone<Value>(value: Value, options?: { transfer?: unknown }): Value;
export function structuredClone(value: unknown, options?: { transfer?: unknown }): unknown {
	if (value instanceof Headers) return new Headers(value);
	// workerd serializes a Request as its URL plus an init dict. A body is a
	// stream, which only RPC can transfer.
	// https://github.com/cloudflare/workerd/blob/b73ce3ae105c35bafaaad864095079524573a465/src/workerd/api/http.c%2B%2B#L770-L842
	if (value instanceof Request) {
		if (value.body !== null) {
			throw new DOMException(
				'Could not serialize object of type "ReadableStream". This type does not support serialization.',
				"DataCloneError",
			);
		}
		return new Request(value);
	}
	if (typeof value === "object" && value !== null) {
		for (const [type, name] of nonSerializableTypes) {
			if (value instanceof type) {
				throw new DOMException(
					`Could not serialize object of type "${name}". This type does not support serialization.`,
					"DataCloneError",
				);
			}
		}
	}
	const transfer = options?.transfer;
	if (transfer === undefined && isNativeError(value)) {
		return cloneError(value);
	}
	if (Array.isArray(transfer)) {
		return nodeStructuredClone(value, { ...options, transfer: [...new Set(transfer)] });
	}
	// SAFETY: Node.js converts and validates caller-provided options with WebIDL rules at
	// runtime, but its options type only accepts a Transferable array as the transfer list.
	return nodeStructuredClone(value, options as Parameters<typeof nodeStructuredClone>[1]);
}

// With enhanced_error_serialization, workerd copies every own property except
// name and message onto a plain object with [[Set]], then recreates each one
// on the clone with CreateDataProperty. Node.js keeps only the standard fields.
// Errors nested inside other values still clone with Node.js semantics.
// https://github.com/cloudflare/workerd/blob/b73ce3ae105c35bafaaad864095079524573a465/src/workerd/jsg/ser.c%2B%2B#L240-L288
function cloneError(error: Error): Error {
	const ownProperties: Record<PropertyKey, unknown> = {};
	for (const key of Reflect.ownKeys(error)) {
		if (key === "name" || key === "message" || typeof key === "symbol") continue;
		ownProperties[key] = Reflect.get(error, key);
	}
	const clone = nodeStructuredClone(error);
	const clonedProperties = nodeStructuredClone(ownProperties);
	for (const key of Object.keys(clonedProperties)) {
		Object.defineProperty(clone, key, {
			configurable: true,
			enumerable: true,
			value: clonedProperties[key],
			writable: true,
		});
	}
	return clone;
}
