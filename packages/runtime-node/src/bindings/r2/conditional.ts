import { Headers } from "../../globals/http.js";
import { R2StorageError } from "./errors.js";
import { isObject } from "../unknown-values.js";

// Option parsing that workerd does before an R2 request leaves the Worker
// (conditions, ranges, and HTTP metadata), plus the condition and range rules
// that the R2 backend applies. Both storage backends share these.
// https://github.com/cloudflare/workerd/blob/b73ce3ae105c35bafaaad864095079524573a465/src/workerd/api/r2-bucket.c%2B%2B#L273-L318
// https://github.com/cloudflare/workerd/blob/b73ce3ae105c35bafaaad864095079524573a465/src/workerd/api/r2-bucket.c%2B%2B#L402-L458
// https://github.com/cloudflare/workerd/blob/b73ce3ae105c35bafaaad864095079524573a465/src/workerd/api/r2-bucket.c%2B%2B#L1242-L1387

export type R2Etag =
	| { type: "strong"; value: string }
	| { type: "weak"; value: string }
	| { type: "wildcard" };

// JSON-safe so the SQLite backend can evaluate it inside the bucket actor.
export interface R2Conditional {
	etagDoesNotMatch?: R2Etag[];
	etagMatches?: R2Etag[];
	secondsGranularity?: boolean;
	uploadedAfter?: number;
	uploadedBefore?: number;
}

export interface R2HttpFields {
	cacheControl?: string;
	// Milliseconds since the Unix epoch.
	cacheExpiry?: number;
	contentDisposition?: string;
	contentEncoding?: string;
	contentLanguage?: string;
	contentType?: string;
}

export type R2RangeRequest =
	| { header: string; type: "header" }
	| { length?: number; offset?: number; suffix?: number; type: "range" };

export interface R2ResolvedRange {
	length: number;
	offset: number;
}

function isHeaders(value: unknown): value is Headers {
	return value instanceof Headers;
}

function toMillis(value: unknown, name: string): number {
	const time =
		value instanceof Date
			? value.getTime()
			: new Date(typeof value === "string" ? value : Number(value)).getTime();
	if (Number.isNaN(time)) throw new TypeError(`${name} must be a valid Date`);
	return time;
}

function optionalString(record: Record<string, unknown>, name: string): string | undefined {
	const value = record[name];
	return value === undefined ? undefined : String(value);
}

// workerd's iterative If-Match / If-None-Match parser.
// https://github.com/cloudflare/workerd/blob/b73ce3ae105c35bafaaad864095079524573a465/src/workerd/api/r2-bucket.c%2B%2B#L1242-L1316
function parseEtagHeader(header: string): R2Etag[] {
	const etags: R2Etag[] = [];
	let rest = header;
	let commaRequired = false;
	for (;;) {
		rest = rest.replace(/^[ \t]+/, "");
		if (rest.length === 0) return etags;
		const first = rest[0];
		if (first === ",") {
			rest = rest.slice(1);
			commaRequired = false;
			continue;
		}
		if (first === "*") {
			if (commaRequired) {
				throw new Error(
					"Comma was expected to separate etags. Encountered a wildcard character '*' instead.",
				);
			}
			return [{ type: "wildcard" }];
		}
		let weak = false;
		if (first === "W") {
			if (commaRequired) {
				throw new Error(
					"Comma was expected to separate etags. Encountered a weak quotation character 'W' instead. This would otherwise indicate the start of a new weak etag.",
				);
			}
			if (!rest.startsWith('W/"')) {
				throw new Error("Weak etags must start with W/ and their value must be quoted");
			}
			weak = true;
			rest = rest.slice(2);
		} else if (first !== '"') {
			return etags;
		} else if (commaRequired) {
			throw new Error(
				"Comma was expected to separate etags. Encountered a double quote character '\"' instead. This would otherwise indicate the start of a new strong etag.",
			);
		}
		const closing = rest.indexOf('"', 1);
		if (closing === -1) throw new Error("Unclosed double quote for Etag");
		const value = rest.slice(1, closing);
		etags.push(weak ? { type: "weak", value } : { type: "strong", value });
		rest = rest.slice(closing + 1);
		commaRequired = true;
	}
}

function singleEtag(value: unknown): R2Etag[] {
	const etag = String(value);
	if (etag.startsWith('"') && etag.endsWith('"')) {
		throw new TypeError(`Conditional ETag should not be wrapped in quotes (${etag}).`);
	}
	return etag === "*" ? [{ type: "wildcard" }] : [{ type: "strong", value: etag }];
}

export function parseConditional(value: unknown): R2Conditional | undefined {
	if (value === undefined || value === null) return undefined;
	if (isHeaders(value)) {
		const conditional: R2Conditional = { secondsGranularity: true };
		const ifMatch = value.get("if-match");
		if (ifMatch !== null) {
			conditional.etagMatches = parseEtagHeader(ifMatch);
			if (conditional.etagMatches.length === 0) {
				throw new Error("Invalid ETag in if-match header");
			}
		}
		const ifNoneMatch = value.get("if-none-match");
		if (ifNoneMatch !== null) {
			conditional.etagDoesNotMatch = parseEtagHeader(ifNoneMatch);
			if (conditional.etagDoesNotMatch.length === 0) {
				throw new Error("Invalid ETag in if-none-match header");
			}
		}
		const ifModifiedSince = value.get("if-modified-since");
		if (ifModifiedSince !== null) {
			conditional.uploadedAfter = toMillis(ifModifiedSince, "If-Modified-Since");
		}
		const ifUnmodifiedSince = value.get("if-unmodified-since");
		if (ifUnmodifiedSince !== null) {
			conditional.uploadedBefore = toMillis(ifUnmodifiedSince, "If-Unmodified-Since");
		}
		return conditional;
	}
	if (!isObject(value)) throw new TypeError("onlyIf must be an object or Headers");
	const conditional: R2Conditional = {};
	if (value.etagMatches !== undefined) conditional.etagMatches = singleEtag(value.etagMatches);
	if (value.etagDoesNotMatch !== undefined) {
		conditional.etagDoesNotMatch = singleEtag(value.etagDoesNotMatch);
	}
	if (value.uploadedBefore !== undefined) {
		conditional.uploadedBefore = toMillis(value.uploadedBefore, "uploadedBefore");
	}
	if (value.uploadedAfter !== undefined) {
		conditional.uploadedAfter = toMillis(value.uploadedAfter, "uploadedAfter");
	}
	if (value.secondsGranularity === true) conditional.secondsGranularity = true;
	return conditional;
}

function includesEtag(
	conditions: R2Etag[],
	etag: string,
	comparison: "strong" | "weak",
): boolean {
	for (const condition of conditions) {
		if (condition.type === "wildcard") return true;
		if (condition.value === etag && (condition.type === "strong" || comparison === "weak")) {
			return true;
		}
	}
	return false;
}

// Returns whether the condition holds for the object, or for a missing object
// when `metadata` is undefined. This is Miniflare's port of the R2 gateway
// rules (RFC 7232 section 6).
// https://github.com/cloudflare/workers-sdk/blob/be87ff0382c53a294e948e49419d25d653c50e86/packages/miniflare/src/workers/r2/validator.worker.ts#L29-L83
export function conditionPasses(
	condition: R2Conditional,
	metadata: { etag: string; uploaded: number } | undefined,
): boolean {
	if (metadata === undefined) {
		return condition.etagMatches === undefined && condition.uploadedAfter === undefined;
	}
	const truncate = (ms: number): number =>
		condition.secondsGranularity === true ? Math.floor(ms / 1000) * 1000 : ms;
	const ifMatch =
		condition.etagMatches === undefined ||
		includesEtag(condition.etagMatches, metadata.etag, "strong");
	const ifNoneMatch =
		condition.etagDoesNotMatch === undefined ||
		!includesEtag(condition.etagDoesNotMatch, metadata.etag, "weak");
	const lastModified = truncate(metadata.uploaded);
	const ifModifiedSince =
		condition.uploadedAfter === undefined ||
		truncate(condition.uploadedAfter) < lastModified ||
		(condition.etagDoesNotMatch !== undefined && ifNoneMatch);
	const ifUnmodifiedSince =
		condition.uploadedBefore === undefined ||
		lastModified < truncate(condition.uploadedBefore) ||
		(condition.etagMatches !== undefined && ifMatch);
	return ifMatch && ifNoneMatch && ifModifiedSince && ifUnmodifiedSince;
}

function rangeNumber(value: unknown, label: string, name: string): number {
	const number = Number(value);
	if (!(number >= 0)) {
		throw new RangeError(
			`Invalid ${label}. ${name} (${number}) must be greater than or equal to 0.`,
		);
	}
	if (!Number.isInteger(number)) {
		throw new RangeError(
			`Invalid range. ${name} (${number}) must be an integer, not floating point.`,
		);
	}
	return number;
}

export function parseRange(value: unknown): R2RangeRequest | undefined {
	if (value === undefined || value === null) return undefined;
	if (isHeaders(value)) {
		const header = value.get("range");
		return header === null ? undefined : { header, type: "header" };
	}
	if (!isObject(value)) throw new TypeError("range must be an object or Headers");
	const range: R2RangeRequest = { type: "range" };
	if (value.offset !== undefined) {
		range.offset = rangeNumber(value.offset, "range", "Starting offset");
	}
	if (value.length !== undefined) range.length = rangeNumber(value.length, "range", "Length");
	if (value.suffix !== undefined) {
		if (value.offset !== undefined) {
			throw new TypeError("Suffix is incompatible with offset.");
		}
		if (value.length !== undefined) {
			throw new TypeError("Suffix is incompatible with length.");
		}
		range.suffix = rangeNumber(value.suffix, "suffix", "Suffix");
	}
	return range;
}

// One satisfiable `bytes=` range, or undefined for the whole object. Miniflare
// returns the whole object when the header is invalid or has several ranges.
function parseRangeHeader(header: string, size: number): R2ResolvedRange | undefined {
	const match = /^\s*bytes\s*=\s*([^,]*)$/i.exec(header);
	const spec = match?.[1]?.trim();
	if (spec === undefined) return undefined;
	const parts = /^(\d*)\s*-\s*(\d*)$/.exec(spec);
	if (parts === null) return undefined;
	const [, rawStart = "", rawEnd = ""] = parts;
	if (rawStart === "") {
		if (rawEnd === "") return undefined;
		const suffix = Math.min(Number(rawEnd), size);
		return suffix === 0 ? undefined : { length: suffix, offset: size - suffix };
	}
	const start = Number(rawStart);
	const end = rawEnd === "" ? size - 1 : Math.min(Number(rawEnd), size - 1);
	if (start >= size || start > end) return undefined;
	return { length: end - start + 1, offset: start };
}

// https://github.com/cloudflare/workers-sdk/blob/be87ff0382c53a294e948e49419d25d653c50e86/packages/miniflare/src/workers/r2/validator.worker.ts#L141-L183
export function resolveRange(
	range: R2RangeRequest | undefined,
	size: number,
): R2ResolvedRange {
	const whole = { length: size, offset: 0 };
	if (range === undefined) return whole;
	if (range.type === "header") return parseRangeHeader(range.header, size) ?? whole;
	let { length, offset } = range;
	if (range.suffix !== undefined) {
		if (range.suffix <= 0) throw R2StorageError.of("InvalidRange");
		const suffix = Math.min(range.suffix, size);
		offset = size - suffix;
		length = suffix;
	}
	offset ??= 0;
	length ??= size - offset;
	if (offset > size || length <= 0) throw R2StorageError.of("InvalidRange");
	return { length: Math.min(length, size - offset), offset };
}

const httpMetadataHeaders = [
	["contentType", "content-type"],
	["contentLanguage", "content-language"],
	["contentDisposition", "content-disposition"],
	["contentEncoding", "content-encoding"],
	["cacheControl", "cache-control"],
] as const;

export function parseHttpMetadata(value: unknown): R2HttpFields | undefined {
	if (value === undefined || value === null) return undefined;
	const fields: R2HttpFields = {};
	if (isHeaders(value)) {
		for (const [field, header] of httpMetadataHeaders) {
			const headerValue = value.get(header);
			if (headerValue !== null) fields[field] = headerValue;
		}
		const expires = value.get("expires");
		if (expires !== null) fields.cacheExpiry = toMillis(expires, "Expires");
		return fields;
	}
	if (!isObject(value)) throw new TypeError("httpMetadata must be an object or Headers");
	for (const [field] of httpMetadataHeaders) {
		const fieldValue = optionalString(value, field);
		if (fieldValue !== undefined) fields[field] = fieldValue;
	}
	if (value.cacheExpiry !== undefined) {
		fields.cacheExpiry = toMillis(value.cacheExpiry, "cacheExpiry");
	}
	return fields;
}

// Writes stored HTTP metadata to response headers, as
// `R2Object.writeHttpMetadata()` does.
// https://github.com/cloudflare/workerd/blob/b73ce3ae105c35bafaaad864095079524573a465/src/workerd/api/r2-bucket.c%2B%2B#L1400-L1423
export function writeHttpFields(
	fields: R2HttpFields,
	headers: { set(name: string, value: string): void },
): void {
	for (const [field, header] of httpMetadataHeaders) {
		const value = fields[field];
		if (value !== undefined) headers.set(header, value);
	}
	if (fields.cacheExpiry !== undefined) {
		headers.set("expires", new Date(fields.cacheExpiry).toUTCString());
	}
}
