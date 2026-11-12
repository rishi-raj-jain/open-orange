import { serialize } from "node:v8";

/**
 * Serializes a value like `v8.serialize`, into a Buffer over a plain ArrayBuffer. Bun's
 * `v8.serialize` returns a Buffer over a SharedArrayBuffer, which Durable Object RPC, storage,
 * and Queues reject.
 */
export function serializeUnshared(value: unknown): Buffer {
	const bytes = serialize(value);
	if (bytes.buffer instanceof ArrayBuffer) return bytes;
	const copy = Buffer.alloc(bytes.byteLength);
	copy.set(bytes);
	return copy;
}
