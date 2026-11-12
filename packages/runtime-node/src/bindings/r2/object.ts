import { Buffer } from "node:buffer";

import { Blob } from "../../globals/native.js";
import { r2HashAlgorithms, type R2Checksums as R2ChecksumValues, type R2StoredObject } from "./backend.js";
import { writeHttpFields, type R2HttpFields, type R2ResolvedRange } from "./conditional.js";

// The objects that R2 bucket calls return, shaped like workerd's HeadResult
// (R2Object), GetResult (R2ObjectBody), and Checksums classes.
// https://github.com/cloudflare/workerd/blob/b73ce3ae105c35bafaaad864095079524573a465/src/workerd/api/r2-bucket.h#L245-L435

export interface R2HTTPMetadata {
	cacheControl?: string;
	cacheExpiry?: Date;
	contentDisposition?: string;
	contentEncoding?: string;
	contentLanguage?: string;
	contentType?: string;
}

function toArrayBuffer(hex: string): ArrayBuffer {
	const bytes = Buffer.from(hex, "hex");
	return new Uint8Array(bytes).buffer;
}

export class R2Checksums {
	readonly #values: R2ChecksumValues;

	constructor(values: R2ChecksumValues) {
		this.#values = values;
	}

	get md5(): ArrayBuffer | undefined {
		return this.#digest("md5");
	}

	get sha1(): ArrayBuffer | undefined {
		return this.#digest("sha1");
	}

	get sha256(): ArrayBuffer | undefined {
		return this.#digest("sha256");
	}

	get sha384(): ArrayBuffer | undefined {
		return this.#digest("sha384");
	}

	get sha512(): ArrayBuffer | undefined {
		return this.#digest("sha512");
	}

	#digest(field: keyof R2ChecksumValues): ArrayBuffer | undefined {
		const value = this.#values[field];
		return value === undefined ? undefined : toArrayBuffer(value);
	}

	toJSON(): R2ChecksumValues {
		const json: R2ChecksumValues = {};
		for (const { field } of r2HashAlgorithms) {
			const value = this.#values[field];
			if (value !== undefined) json[field] = value;
		}
		return json;
	}
}

function httpMetadataFrom(fields: R2HttpFields | undefined): R2HTTPMetadata | undefined {
	if (fields === undefined) return undefined;
	const { cacheExpiry, ...rest } = fields;
	return cacheExpiry === undefined ? { ...rest } : { ...rest, cacheExpiry: new Date(cacheExpiry) };
}

export class R2Object {
	readonly key: string;
	readonly version: string;
	readonly size: number;
	readonly etag: string;
	readonly httpEtag: string;
	readonly checksums: R2Checksums;
	readonly uploaded: Date;
	readonly httpMetadata: R2HTTPMetadata | undefined;
	readonly customMetadata: Record<string, string> | undefined;
	readonly range: { length: number; offset: number } | undefined;
	readonly storageClass: string;
	readonly ssecKeyMd5: string | undefined;
	readonly #httpFields: R2HttpFields | undefined;

	constructor(stored: R2StoredObject, range?: R2ResolvedRange) {
		this.key = stored.key;
		this.version = stored.version;
		this.size = stored.size;
		this.etag = stored.etag;
		this.httpEtag = `"${stored.etag}"`;
		this.checksums = new R2Checksums(stored.checksums);
		this.uploaded = new Date(stored.uploaded);
		this.httpMetadata = httpMetadataFrom(stored.httpMetadata);
		this.customMetadata =
			stored.customMetadata === undefined ? undefined : { ...stored.customMetadata };
		this.range = range === undefined ? undefined : { length: range.length, offset: range.offset };
		this.storageClass = stored.storageClass;
		this.ssecKeyMd5 = undefined;
		this.#httpFields = stored.httpMetadata;
	}

	writeHttpMetadata(headers: { set(name: string, value: string): void }): void {
		if (this.#httpFields === undefined) {
			throw new TypeError(
				`HTTP metadata unknown for key \`${this.key}\`. Did you forget to add 'httpMetadata' to \`include\` when listing?`,
			);
		}
		writeHttpFields(this.#httpFields, headers);
	}
}

export class R2ObjectBody extends R2Object {
	readonly #body: ReadableStream<Uint8Array>;
	#consumed = false;

	constructor(stored: R2StoredObject, body: ReadableStream<Uint8Array>, range: R2ResolvedRange) {
		super(stored, range);
		this.#body = body;
	}

	get body(): ReadableStream<Uint8Array> {
		return this.#body;
	}

	get bodyUsed(): boolean {
		return this.#consumed || this.#body.locked;
	}

	async #read(): Promise<Uint8Array> {
		if (this.bodyUsed) {
			throw new TypeError(
				"Body has already been used. It can only be used once. Use tee() first if you need to read it twice.",
			);
		}
		this.#consumed = true;
		const pieces: Uint8Array[] = [];
		for await (const piece of this.#body) pieces.push(piece);
		return Buffer.concat(pieces);
	}

	async arrayBuffer(): Promise<ArrayBuffer> {
		const bytes = await this.#read();
		return new Uint8Array(bytes).buffer;
	}

	async bytes(): Promise<Uint8Array> {
		return new Uint8Array(await this.arrayBuffer());
	}

	async text(): Promise<string> {
		return new TextDecoder().decode(await this.#read());
	}

	async json<T>(): Promise<T> {
		// Like workerd, the caller names the parsed type.
		return JSON.parse(await this.text());
	}

	async blob(): Promise<Blob> {
		return new Blob([await this.arrayBuffer()], {
			type: this.httpMetadata?.contentType ?? "",
		});
	}
}
