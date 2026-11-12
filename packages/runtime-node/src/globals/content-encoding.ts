import { pipeline, Readable, type Transform } from "node:stream";
import {
	createBrotliCompress,
	createBrotliDecompress,
	createGunzip,
	createGzip,
} from "node:zlib";

import { bodyChunkBytes, responseEncodesBodyManually } from "./http.js";

export type ContentCoding = "br" | "gzip";

interface EncodableResponse {
	readonly body: ReadableStream | null;
	readonly headers: { get(name: string): string | null };
}

// Workerd applies a body's Content-Encoding only when the header is exactly
// `gzip`, or `br` with brotli_content_encoding, which Orange's profile enables.
// Any other value leaves the body as it is.
// https://github.com/cloudflare/workerd/blob/b73ce3ae105c35bafaaad864095079524573a465/src/workerd/api/system-streams.c%2B%2B#L492-L507
function contentCoding(response: EncodableResponse): ContentCoding | undefined {
	const value = response.headers.get("content-encoding");
	return value === "gzip" || value === "br" ? value : undefined;
}

// The coding to apply when the runtime sends this response over HTTP. Workerd
// compresses the body unless the response uses `encodeBody: "manual"`.
// https://github.com/cloudflare/workerd/blob/b73ce3ae105c35bafaaad864095079524573a465/src/workerd/api/http.c%2B%2B#L1300-L1304
export function outgoingBodyCoding(
	response: EncodableResponse,
): ContentCoding | undefined {
	if (response.body === null || responseEncodesBodyManually(response)) {
		return undefined;
	}
	return contentCoding(response);
}

// The coding of a body that the Worker already encoded with
// `encodeBody: "manual"`. A receiving fetch() decodes it.
// https://github.com/cloudflare/workerd/blob/b73ce3ae105c35bafaaad864095079524573a465/src/workerd/api/http.c%2B%2B#L2185-L2187
export function manualBodyCoding(
	response: EncodableResponse,
): ContentCoding | undefined {
	if (response.body === null || !responseEncodesBodyManually(response)) {
		return undefined;
	}
	return contentCoding(response);
}

function transformBody(
	body: ReadableStream,
	transform: Transform,
): ReadableStream<Uint8Array> {
	// The pipeline cancels the source when the consumer cancels the result and
	// errors the result when the source errors.
	pipeline(
		Readable.fromWeb(body, { objectMode: true }),
		async function* (chunks: AsyncIterable<unknown>) {
			for await (const chunk of chunks) {
				const bytes = bodyChunkBytes(chunk);
				if (bytes.byteLength > 0) yield bytes;
			}
		},
		transform,
		() => undefined,
	);
	return Readable.toWeb(transform);
}

export function encodeBody(
	body: ReadableStream,
	coding: ContentCoding,
): ReadableStream<Uint8Array> {
	return transformBody(
		body,
		coding === "gzip" ? createGzip() : createBrotliCompress(),
	);
}

export function decodeBody(
	body: ReadableStream,
	coding: ContentCoding,
): ReadableStream<Uint8Array> {
	return transformBody(
		body,
		coding === "gzip" ? createGunzip() : createBrotliDecompress(),
	);
}
