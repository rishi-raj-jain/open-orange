import { deserialize } from "node:v8";
import { isRecord } from "../unknown-values.js";
import { serializeUnshared } from "../../internal/v8-serialize.js";

export type QueueContentType = "bytes" | "json" | "text" | "v8";

// One Queues message as the `openorange:queue` actor stores it in its RivetKit
// queue, in schedules for delayed delivery, and in action arguments.
export interface QueueEnvelope {
	// Failed deliveries so far. `Message.attempts` is one more.
	attempts: number;
	// A string for `text` and `json`. RivetKit's CBOR layer base64-encodes a
	// Uint8Array, which would cost a third of the message size limit, but it
	// stores other typed arrays as raw bytes.
	body: string | Uint8ClampedArray;
	contentType: QueueContentType;
	id: string;
	// Epoch milliseconds of the first send.
	timestamp: number;
	// A body that a caller of a service binding's queue() already read. Never stored.
	decoded?: { value: unknown };
}

function isQueueContentType(value: string): value is QueueContentType {
	return value === "bytes" || value === "json" || value === "text" || value === "v8";
}

// https://github.com/cloudflare/workerd/blob/b73ce3ae105c35bafaaad864095079524573a465/src/workerd/api/queue.c%2B%2B#L67-L81
export function parseQueueContentType(contentType: string): QueueContentType {
	const lowerCase = contentType.toLowerCase();
	if (!isQueueContentType(lowerCase)) {
		throw new TypeError(`Unsupported queue message content type: ${contentType}`);
	}
	return lowerCase;
}

function describeType(value: unknown): string {
	return value === null ? "null" : typeof value;
}

// Serializes a body like workerd. `json` is the default content type under the
// `queues_json_messages` compatibility flag, which Orange's profile enables.
// https://github.com/cloudflare/workerd/blob/b73ce3ae105c35bafaaad864095079524573a465/src/workerd/api/queue.c%2B%2B#L130-L192
export function encodeQueueBody(
	body: unknown,
	contentType: QueueContentType,
): QueueEnvelope["body"] {
	switch (contentType) {
		case "text":
			if (typeof body !== "string") {
				throw new TypeError(
					`Content Type "text" requires a value of type string, but received: ${describeType(body)}`,
				);
			}
			return body;
		case "bytes": {
			if (!ArrayBuffer.isView(body)) {
				throw new TypeError(
					`Content Type "bytes" requires a value of type ArrayBufferView, but received: ${describeType(body)}`,
				);
			}
			return new Uint8ClampedArray(
				body.buffer.slice(body.byteOffset, body.byteOffset + body.byteLength),
			);
		}
		case "json": {
			const json: unknown = JSON.stringify(body);
			if (typeof json !== "string") {
				throw new TypeError(`Cannot serialize a value of type ${describeType(body)} as JSON`);
			}
			return json;
		}
		case "v8": {
			const bytes = serializeUnshared(body);
			return new Uint8ClampedArray(bytes.buffer, bytes.byteOffset, bytes.byteLength);
		}
	}
}

// https://github.com/cloudflare/workerd/blob/b73ce3ae105c35bafaaad864095079524573a465/src/workerd/api/queue.c%2B%2B#L200-L215
export function decodeQueueBody(envelope: QueueEnvelope): unknown {
	if (envelope.decoded !== undefined) return envelope.decoded.value;
	const { body, contentType } = envelope;
	switch (contentType) {
		case "text":
		case "json":
			if (typeof body !== "string") {
				throw new TypeError(`Queue message ${envelope.id} has an invalid ${contentType} body`);
			}
			return contentType === "text" ? body : JSON.parse(body);
		case "bytes":
		case "v8": {
			if (!(body instanceof Uint8ClampedArray)) {
				throw new TypeError(`Queue message ${envelope.id} has an invalid ${contentType} body`);
			}
			const bytes = new Uint8Array(body.buffer, body.byteOffset, body.byteLength);
			return contentType === "bytes" ? bytes.slice() : deserialize(bytes);
		}
	}
}

// The body size that counts toward Cloudflare's limits and backlog metrics.
export function queueBodyBytes(body: QueueEnvelope["body"]): number {
	return typeof body === "string" ? Buffer.byteLength(body) : body.byteLength;
}

// Envelopes come back from RivetKit storage and action arguments as unknown.
export function parseQueueEnvelope(value: unknown): QueueEnvelope {
	if (
		!isRecord(value) ||
		typeof value.attempts !== "number" ||
		!(typeof value.body === "string" || value.body instanceof Uint8ClampedArray) ||
		typeof value.contentType !== "string" ||
		!isQueueContentType(value.contentType) ||
		typeof value.id !== "string" ||
		typeof value.timestamp !== "number"
	) {
		throw new TypeError("OpenOrange received an invalid queue message envelope");
	}
	return {
		attempts: value.attempts,
		body: value.body,
		contentType: value.contentType,
		id: value.id,
		timestamp: value.timestamp,
	};
}
