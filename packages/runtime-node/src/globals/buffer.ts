import { Buffer } from "node:buffer";

let installed = false;

const utf16Encodings = new Set(["ucs2", "ucs-2", "utf16le", "utf-16le"]);

function isUtf16(encoding: unknown): boolean {
	return typeof encoding === "string" && utf16Encodings.has(encoding.toLowerCase());
}

// Patches Node.js Buffer methods that diverge from workerd's Buffer.
export function installBufferPatches(): void {
	if (installed) return;
	installed = true;
	const prototype = Buffer.prototype;

	// workerd reports an oversized result as a RangeError from V8's string
	// limit. Node.js throws a plain Error with ERR_STRING_TOO_LONG.
	// https://github.com/cloudflare/workerd/blob/b73ce3ae105c35bafaaad864095079524573a465/src/workerd/jsg/jsvalue.h#L1340-L1374
	const nodeToString = prototype.toString;
	const toString = function toString(
		this: Buffer,
		...args: Parameters<Buffer["toString"]>
	): string {
		try {
			return nodeToString.apply(this, args);
		} catch (error: unknown) {
			if (
				error instanceof Error &&
				Reflect.get(error, "code") === "ERR_STRING_TOO_LONG"
			) {
				throw new RangeError("String is too long for a V8 string");
			}
			throw error;
		}
	};
	// Node.js aliases toLocaleString to toString.
	for (const name of ["toString", "toLocaleString"]) {
		Object.defineProperty(prototype, name, {
			configurable: true,
			enumerable: false,
			writable: true,
			value: toString,
		});
	}

	// Node.js loops forever when it searches a UTF-16 needle in a buffer at an
	// odd byte offset, so search an aligned copy instead. includes() calls
	// indexOf().
	for (const name of ["indexOf", "lastIndexOf"] as const) {
		const search: Function = prototype[name];
		const alignedSearch = function (this: Buffer, ...args: unknown[]): unknown {
			const encoding = typeof args[1] === "string" ? args[1] : args[2];
			const target =
				this.byteOffset % 2 === 1 &&
				typeof args[0] === "string" &&
				isUtf16(encoding)
					? Buffer.from(this)
					: this;
			return Reflect.apply(search, target, args);
		};
		Object.defineProperty(alignedSearch, "name", { value: name });
		Object.defineProperty(prototype, name, {
			configurable: true,
			enumerable: false,
			writable: true,
			value: alignedSearch,
		});
	}
}
