import type { R2Backend, R2Body, R2UploadedPart } from "./backend.js";
import type { R2Action } from "./errors.js";
import { R2Object } from "./object.js";

// `R2MultipartUpload`, as returned by `createMultipartUpload()` and
// `resumeMultipartUpload()`. Part number validation follows workerd.
// https://github.com/cloudflare/workerd/blob/b73ce3ae105c35bafaaad864095079524573a465/src/workerd/api/r2-multipart.c%2B%2B#L33-L41

// What the bucket lends an upload: its backend, its value and key checks,
// and its error wrapping.
export interface R2MultipartContext {
	readonly backend: R2Backend;
	putValue(value: unknown): Promise<R2Body>;
	run<T>(action: R2Action, key: string, operation: () => Promise<T>): Promise<T>;
	unsupportedSsecKey(action: R2Action, options: unknown): void;
}

function validPartNumber(value: unknown): number {
	const partNumber = Math.trunc(Number(value));
	if (!(partNumber >= 1 && partNumber <= 10000)) {
		throw new TypeError(
			`Part number must be between 1 and 10000 (inclusive). Actual value was: ${partNumber}`,
		);
	}
	return partNumber;
}

export class R2MultipartUpload {
	readonly key: string;
	readonly uploadId: string;
	readonly #context: R2MultipartContext;

	constructor(key: string, uploadId: string, context: R2MultipartContext) {
		this.key = key;
		this.uploadId = uploadId;
		this.#context = context;
	}

	async uploadPart(
		partNumber: number,
		value: unknown,
		options?: unknown,
	): Promise<R2UploadedPart> {
		const number = validPartNumber(partNumber);
		this.#context.unsupportedSsecKey("uploadPart", options);
		const body = await this.#context.putValue(value);
		return await this.#context.run("uploadPart", this.key, async () => ({
			etag: await this.#context.backend.uploadPart(this.key, this.uploadId, number, body),
			partNumber: number,
		}));
	}

	async abort(): Promise<void> {
		await this.#context.run("abortMultipartUpload", this.key, () =>
			this.#context.backend.abortMultipartUpload(this.key, this.uploadId),
		);
	}

	async complete(uploadedParts: unknown): Promise<R2Object> {
		if (!Array.isArray(uploadedParts)) {
			throw new TypeError("complete() requires an array of uploaded parts");
		}
		const parts = uploadedParts.map((part: unknown) => {
			if (typeof part !== "object" || part === null) {
				throw new TypeError("Each uploaded part must be an object");
			}
			return {
				etag: String(Reflect.get(part, "etag")),
				partNumber: validPartNumber(Reflect.get(part, "partNumber")),
			};
		});
		const stored = await this.#context.run("completeMultipartUpload", this.key, () =>
			this.#context.backend.completeMultipartUpload(this.key, this.uploadId, parts),
		);
		return new R2Object(stored);
	}
}
