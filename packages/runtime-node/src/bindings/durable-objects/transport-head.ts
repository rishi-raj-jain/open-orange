import { Buffer } from "node:buffer";
import { isRecord } from "../unknown-values.js";

// Orange reaches a Durable Object over HTTP through the Rivet gateway. The
// gateway adds its own request and response headers, overwrites CORS headers,
// and answers OPTIONS preflights before the actor sees them. Workerd delivers
// the caller's request and the object's response unchanged, so Orange carries
// each head in one internal header and rebuilds it on the other side instead of
// reading the transport's own headers.
// https://github.com/rivet-dev/actors/blob/a2b9069f7c48713196f02dd60bdbe667bfd5e4d8/engine/packages/guard/src/routing/pegboard_gateway/mod.rs#L209-L211
// https://github.com/rivet-dev/actors/blob/a2b9069f7c48713196f02dd60bdbe667bfd5e4d8/engine/packages/guard-core/src/proxy_service.rs#L660-L706

/** Orange owns every header with this prefix; inbound client requests never carry one. */
export const openOrangeInternalHeaderPrefix = "x-open-orange-internal-";

const requestHeadHeader = `${openOrangeInternalHeaderPrefix}durable-object-request`;
const responseHeadHeader = `${openOrangeInternalHeaderPrefix}durable-object-response`;

export type HeaderEntries = [string, string][];

interface HeaderList extends Iterable<[string, string]> {
	get(name: string): string | null;
}

export interface DurableObjectRequestHead {
	/** Workerd gives the object a null body only when the caller sent none. */
	body: boolean;
	cf?: unknown;
	headers: HeaderEntries;
	method: string;
}

export interface DurableObjectResponseHead {
	headers: HeaderEntries;
	statusText: string;
}

export function headerEntries(value: unknown): HeaderEntries {
	if (!Array.isArray(value)) {
		throw new TypeError("Durable Object headers must be an array");
	}
	const headers: HeaderEntries = [];
	for (const entry of value) {
		if (
			!Array.isArray(entry) ||
			entry.length !== 2 ||
			typeof entry[0] !== "string" ||
			typeof entry[1] !== "string"
		) {
			throw new TypeError("Durable Object header entry is invalid");
		}
		headers.push([entry[0], entry[1]]);
	}
	return headers;
}

// Header values are byte strings, but `cf` may hold any text, so the JSON
// travels as base64 UTF-8.
function encodeHead(value: unknown): string {
	return Buffer.from(JSON.stringify(value), "utf8").toString("base64");
}

function decodeHead(value: string): unknown {
	return JSON.parse(Buffer.from(value, "base64").toString("utf8"));
}

/**
 * Captures what workerd sends to an object: the caller's method, headers, and
 * `cf` serialized as JSON.
 * https://github.com/cloudflare/workerd/blob/b73ce3ae105c35bafaaad864095079524573a465/src/workerd/api/http.c%2B%2B#L629-L652
 * https://github.com/cloudflare/workerd/blob/b73ce3ae105c35bafaaad864095079524573a465/src/workerd/api/global-scope.c%2B%2B#L294
 */
// Takes the fields both Node's and Orange's Request classes have.
export function durableObjectRequestHead(request: {
	readonly body: unknown;
	readonly headers: Iterable<[string, string]>;
	readonly method: string;
}): DurableObjectRequestHead {
	const cf: unknown = Reflect.get(request, "cf");
	return {
		body: request.body !== null,
		...(cf === undefined ? {} : { cf }),
		headers: [...request.headers],
		method: request.method,
	};
}

export function readDurableObjectCf(value: unknown): unknown {
	if (value !== undefined && !isRecord(value)) {
		throw new TypeError("Durable Object request cf is invalid");
	}
	return value;
}

export function durableObjectTransportRequestHeaders(
	head: DurableObjectRequestHead,
): HeaderEntries {
	return [[requestHeadHeader, encodeHead(head)]];
}

export function readDurableObjectRequestHead(request: {
	readonly headers: { get(name: string): string | null };
}): DurableObjectRequestHead {
	const encoded = request.headers.get(requestHeadHeader);
	if (encoded === null) {
		throw new TypeError("Durable Object fetch request is missing its request head");
	}
	const value = decodeHead(encoded);
	if (
		!isRecord(value) ||
		typeof value.body !== "boolean" ||
		typeof value.method !== "string"
	) {
		throw new TypeError("Durable Object fetch request head is invalid");
	}
	const cf = readDurableObjectCf(value.cf);
	return {
		body: value.body,
		...(cf === undefined ? {} : { cf }),
		headers: headerEntries(value.headers),
		method: value.method,
	};
}

/** Transport headers for an object's response; its real head travels inside them. */
export function durableObjectTransportResponseHeaders(
	headers: HeaderList,
	statusText: string,
): HeaderEntries {
	const head: DurableObjectResponseHead = { headers: [...headers], statusText };
	const transport: HeaderEntries = [[responseHeadHeader, encodeHead(head)]];
	// The caller's fetch() decodes the body by the coding the transport declares.
	const coding = headers.get("content-encoding");
	if (coding !== null) transport.push(["content-encoding", coding]);
	return transport;
}

/** Returns undefined when the response did not come from the object, such as a gateway error. */
export function readDurableObjectResponseHead(response: {
	readonly headers: { get(name: string): string | null };
}): DurableObjectResponseHead | undefined {
	const encoded = response.headers.get(responseHeadHeader);
	if (encoded === null) return undefined;
	const value = decodeHead(encoded);
	if (!isRecord(value) || typeof value.statusText !== "string") {
		throw new TypeError("Durable Object response head is invalid");
	}
	return { headers: headerEntries(value.headers), statusText: value.statusText };
}
