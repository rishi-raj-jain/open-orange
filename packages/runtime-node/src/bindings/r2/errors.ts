// R2 errors as the Workers runtime reports them. workerd turns a backend error
// into a plain Error whose message is `<action>: <message> (<v4 code>)`.
// https://github.com/cloudflare/workerd/blob/b73ce3ae105c35bafaaad864095079524573a465/src/workerd/api/r2-rpc.c%2B%2B#L46-L63
// The codes and messages are Miniflare's R2 error table.
// https://github.com/cloudflare/workers-sdk/blob/be87ff0382c53a294e948e49419d25d653c50e86/packages/miniflare/src/workers/r2/errors.worker.ts#L6-L218

export type R2Action =
	| "abortMultipartUpload"
	| "completeMultipartUpload"
	| "createMultipartUpload"
	| "delete"
	| "get"
	| "head"
	| "list"
	| "put"
	| "uploadPart";

const r2Errors = {
	BadUpload: [10048, "There was a problem with the multipart upload."],
	EntityTooLarge: [100100, "Your proposed upload exceeds the maximum allowed object size."],
	EntityTooSmall: [
		10011,
		"Your proposed upload is smaller than the minimum allowed object size.",
	],
	InternalError: [10001, "We encountered an internal error. Please try again."],
	InvalidMaxKeys: [10022, "MaxKeys params must be positive integer <= 1000."],
	InvalidObjectName: [10020, "The specified object name is not valid."],
	InvalidPart: [10025, "One or more of the specified parts could not be found."],
	InvalidRange: [10039, "The requested range is not satisfiable"],
	MetadataTooLarge: [
		10012,
		"Your metadata headers exceed the maximum allowed metadata size.",
	],
	NoSuchUpload: [10024, "The specified multipart upload does not exist."],
} as const satisfies Record<string, readonly [number, string]>;

export type R2ErrorKind = keyof typeof r2Errors;

// A storage failure before it gets its action prefix. Backends throw it, and
// the bucket rethrows it as the runtime's Error.
export class R2StorageError extends Error {
	readonly code: number;

	constructor(code: number, message: string) {
		super(message);
		this.code = code;
	}

	static of(kind: R2ErrorKind, detail?: string): R2StorageError {
		const [code, message] = r2Errors[kind];
		return new R2StorageError(code, detail === undefined ? message : `${message} (${detail})`);
	}
}

export function isR2StorageError(value: unknown): value is R2StorageError {
	return value instanceof R2StorageError;
}

export function badDigest(algorithm: string, provided: string, actual: string): R2StorageError {
	return new R2StorageError(
		10037,
		[
			`The ${algorithm} checksum you specified did not match what we received.`,
			`You provided a ${algorithm} checksum with value: ${provided}`,
			`Actual ${algorithm} was: ${actual}`,
		].join("\n"),
	);
}

export function runtimeError(action: R2Action, error: R2StorageError): Error {
	return new Error(`${action}: ${error.message} (${error.code})`);
}

export function notSupported(action: R2Action, feature: string): Error {
	return new DOMException(
		`${action}: ${feature} is not supported by OpenOrange yet.`,
		"NotSupportedError",
	);
}
