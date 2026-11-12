import { r2HashAlgorithms, type R2Checksums, type R2HashField, type R2ListPage, type R2ListRequest, type R2StoredObject, type R2UploadedPart, type R2WriteMetadata } from "./backend.js";
import type { R2Conditional, R2Etag, R2HttpFields } from "./conditional.js";
import type {
	R2BlobSegment,
	R2CommitRequest,
	R2ErrorBody,
	R2GetResponse,
	R2PartRequest,
} from "./storage.js";
import { isRecord } from "../unknown-values.js";

// Parsers for the JSON that the R2 bucket client (./actor-backend.ts) and the bucket object
// (./storage.ts) exchange, and for the JSON columns the bucket object stores. Each one checks
// the shape and throws a TypeError that names the value it could not read.

export type R2Json = Record<string, unknown>;

function invalid(what: string): TypeError {
	return new TypeError(`R2 received an invalid ${what}`);
}

function record(value: unknown, what: string): R2Json {
	if (!isRecord(value)) throw invalid(what);
	return value;
}

function string(value: unknown, what: string): string {
	if (typeof value !== "string") throw invalid(what);
	return value;
}

function number(value: unknown, what: string): number {
	if (typeof value !== "number" || !Number.isFinite(value)) throw invalid(what);
	return value;
}

function array(value: unknown, what: string): unknown[] {
	if (!Array.isArray(value)) throw invalid(what);
	return value;
}

function optional<T>(value: unknown, parse: (value: unknown) => T): T | undefined {
	return value === undefined ? undefined : parse(value);
}

// Copies only the keys whose value is defined, as JSON round trips drop the others.
function defined<T extends object>(fields: T): T {
	const result = { ...fields };
	for (const key of Object.keys(result)) {
		if (Reflect.get(result, key) === undefined) Reflect.deleteProperty(result, key);
	}
	return result;
}

/** The hash fields that `expected` names, in R2's algorithm order. */
export function r2ExpectedHashFields(expected: R2Checksums): R2HashField[] {
	return r2HashAlgorithms
		.map((algorithm) => algorithm.field)
		.filter((field) => expected[field] !== undefined);
}

export function parseR2Checksums(value: unknown): R2Checksums {
	const source = record(value, "checksum set");
	const checksums: R2Checksums = {};
	for (const { field } of r2HashAlgorithms) {
		const digest = source[field];
		if (digest !== undefined) checksums[field] = string(digest, `${field} checksum`);
	}
	return checksums;
}

export function parseR2StringMap(value: unknown, what: string): Record<string, string> {
	const source = record(value, what);
	const map: Record<string, string> = {};
	for (const [key, entry] of Object.entries(source)) map[key] = string(entry, what);
	return map;
}

export function parseR2HttpFields(value: unknown): R2HttpFields {
	const source = record(value, "HTTP metadata");
	const text = (key: string): string | undefined =>
		optional(source[key], (entry) => string(entry, `HTTP metadata ${key}`));
	return defined({
		cacheControl: text("cacheControl"),
		cacheExpiry: optional(source.cacheExpiry, (entry) => number(entry, "HTTP metadata cacheExpiry")),
		contentDisposition: text("contentDisposition"),
		contentEncoding: text("contentEncoding"),
		contentLanguage: text("contentLanguage"),
		contentType: text("contentType"),
	});
}

function parseEtag(value: unknown): R2Etag {
	const source = record(value, "ETag condition");
	if (source.type === "wildcard") return { type: "wildcard" };
	if (source.type === "strong" || source.type === "weak") {
		return { type: source.type, value: string(source.value, "ETag condition") };
	}
	throw invalid("ETag condition");
}

function parseConditional(value: unknown): R2Conditional {
	const source = record(value, "onlyIf condition");
	const etags = (entry: unknown): R2Etag[] => array(entry, "ETag condition").map(parseEtag);
	const time = (entry: unknown): number => number(entry, "onlyIf time");
	return defined({
		etagDoesNotMatch: optional(source.etagDoesNotMatch, etags),
		etagMatches: optional(source.etagMatches, etags),
		secondsGranularity: optional(source.secondsGranularity, (entry) => {
			if (typeof entry !== "boolean") throw invalid("onlyIf secondsGranularity");
			return entry;
		}),
		uploadedAfter: optional(source.uploadedAfter, time),
		uploadedBefore: optional(source.uploadedBefore, time),
	});
}

function parseWriteMetadata(source: R2Json): R2WriteMetadata {
	return defined({
		customMetadata: optional(source.customMetadata, (entry) =>
			parseR2StringMap(entry, "custom metadata"),
		),
		httpMetadata: optional(source.httpMetadata, parseR2HttpFields),
		storageClass: optional(source.storageClass, (entry) => string(entry, "storage class")),
	});
}

export function parseR2StoredObject(value: unknown): R2StoredObject {
	const source = record(value, "object");
	return defined({
		checksums: parseR2Checksums(source.checksums),
		customMetadata: optional(source.customMetadata, (entry) =>
			parseR2StringMap(entry, "custom metadata"),
		),
		etag: string(source.etag, "object etag"),
		httpMetadata: optional(source.httpMetadata, parseR2HttpFields),
		key: string(source.key, "object key"),
		size: number(source.size, "object size"),
		storageClass: string(source.storageClass, "object storage class"),
		uploaded: number(source.uploaded, "object upload time"),
		version: string(source.version, "object version"),
	});
}

/** Reads `{ object }`, the answer to head, put, and multipart completion. */
export function parseR2ObjectResponse(value: unknown): R2StoredObject {
	return parseR2StoredObject(record(value, "object response").object);
}

function parseSegment(value: unknown): R2BlobSegment {
	const source = record(value, "blob segment");
	return { blobId: string(source.blobId, "blob ID"), size: number(source.size, "blob size") };
}

export function parseR2GetResponse(value: unknown): R2GetResponse {
	const source = record(value, "get response");
	return {
		object: parseR2StoredObject(source.object),
		segments: array(source.segments, "blob segments").map(parseSegment),
	};
}

export function parseR2ListPage(value: unknown): R2ListPage {
	const source = record(value, "list page");
	if (typeof source.truncated !== "boolean") throw invalid("list page");
	return defined({
		cursor: optional(source.cursor, (entry) => string(entry, "list cursor")),
		delimitedPrefixes: array(source.delimitedPrefixes, "delimited prefixes").map((prefix) =>
			string(prefix, "delimited prefix"),
		),
		objects: array(source.objects, "listed objects").map(parseR2StoredObject),
		truncated: source.truncated,
	});
}

export function parseR2ListRequest(value: unknown): R2ListRequest {
	const source = record(value, "list request");
	const text = (entry: unknown): string => string(entry, "list option");
	if (
		typeof source.includeCustomMetadata !== "boolean" ||
		typeof source.includeHttpMetadata !== "boolean"
	) {
		throw invalid("list request");
	}
	return defined({
		cursor: optional(source.cursor, text),
		delimiter: optional(source.delimiter, text),
		includeCustomMetadata: source.includeCustomMetadata,
		includeHttpMetadata: source.includeHttpMetadata,
		limit: number(source.limit, "list limit"),
		prefix: string(source.prefix, "list prefix"),
		startAfter: optional(source.startAfter, text),
	});
}

export function parseR2CommitRequest(value: unknown): R2CommitRequest {
	const source = record(value, "put request");
	return defined({
		...parseWriteMetadata(source),
		blobId: string(source.blobId, "blob ID"),
		checksums: parseR2Checksums(source.checksums),
		etag: string(source.etag, "put etag"),
		key: string(source.key, "object key"),
		onlyIf: optional(source.onlyIf, parseConditional),
		size: number(source.size, "put size"),
	});
}

export function parseR2PartRequest(value: unknown): R2PartRequest {
	const source = record(value, "part request");
	return {
		blobId: string(source.blobId, "blob ID"),
		key: string(source.key, "object key"),
		md5: string(source.md5, "part MD5"),
		partNumber: number(source.partNumber, "part number"),
		size: number(source.size, "part size"),
		uploadId: string(source.uploadId, "upload ID"),
	};
}

export function parseR2CreateUploadRequest(value: unknown): { key: string } & R2WriteMetadata {
	const source = record(value, "multipart upload request");
	return { ...parseWriteMetadata(source), key: string(source.key, "object key") };
}

export function parseR2UploadRequest(value: unknown): { key: string; uploadId: string } {
	const source = record(value, "multipart upload request");
	return { key: string(source.key, "object key"), uploadId: string(source.uploadId, "upload ID") };
}

export function parseR2CompleteRequest(
	value: unknown,
): { key: string; parts: R2UploadedPart[]; uploadId: string } {
	const source = record(value, "multipart completion");
	return {
		...parseR2UploadRequest(source),
		parts: array(source.parts, "uploaded parts").map((part) => {
			const entry = record(part, "uploaded part");
			return {
				etag: string(entry.etag, "part etag"),
				partNumber: number(entry.partNumber, "part number"),
			};
		}),
	};
}

export function parseR2ChunkRead(value: unknown): { blob: string; idx: number } {
	const source = record(value, "chunk read");
	return { blob: string(source.blob, "blob ID"), idx: number(source.idx, "chunk index") };
}

/** Reads a bucket object error body, or returns undefined for any other body. */
export function parseR2ErrorBody(value: unknown): R2ErrorBody | undefined {
	if (!isRecord(value) || !isRecord(value.error)) return undefined;
	const { code, message } = value.error;
	if (typeof code !== "number" || typeof message !== "string") return undefined;
	return { error: { code, message } };
}

/** Reads a string field of a JSON answer, such as `uploadId` or `etag`. */
export function parseR2StringField(value: unknown, field: string): string {
	return string(record(value, `${field} response`)[field], field);
}
