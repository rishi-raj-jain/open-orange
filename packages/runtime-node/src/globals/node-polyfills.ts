// Fills the APIs that Orange uses and that Node.js 22 lacks: `URLPattern`
// (Node.js 23.8), `CloseEvent` (Node.js 23.0), `Error.isError` (Node.js 24) and
// `zlib.crc32` (Node.js 22.2). Each fill checks for the API, so Node.js 24 keeps
// its own. Modules that read these APIs at load time call
// `installNodePolyfills()` first. A call, not a side-effect import, keeps the
// order in esbuild's split chunks.

import zlib from "node:zlib";

// Sets URLPattern only where it is missing.
import "./url-pattern-polyfill.js";
import { installUint8ArrayEncoding } from "./uint8array-encoding.js";

export function installNodePolyfills(): void {
	installErrorIsError();
	installCloseEvent();
	installZlibCrc32();
	installUint8ArrayEncoding();
}

function installErrorIsError(): void {
	if (typeof Reflect.get(Error, "isError") === "function") return;
	Reflect.defineProperty(Error, "isError", {
		configurable: true,
		value: (value: unknown): boolean =>
			value instanceof Error || Object.prototype.toString.call(value) === "[object Error]",
		writable: true,
	});
}

function installCloseEvent(): void {
	if (Reflect.get(globalThis, "CloseEvent") !== undefined) return;
	Reflect.defineProperty(globalThis, "CloseEvent", {
		configurable: true,
		value: class CloseEvent extends Event {
			readonly code: number;
			readonly reason: string;
			readonly wasClean: boolean;
			constructor(
				type: string,
				init?: {
					bubbles?: boolean;
					cancelable?: boolean;
					composed?: boolean;
					code?: number;
					reason?: string;
					wasClean?: boolean;
				},
			) {
				super(type, init);
				this.code = init?.code ?? 0;
				this.reason = init?.reason ?? "";
				this.wasClean = init?.wasClean ?? false;
			}
		},
		writable: true,
	});
}

// The node:zlib runtime module calls `crc32` on the default export, so filling
// the built-in object is enough.
function installZlibCrc32(): void {
	if (typeof Reflect.get(zlib, "crc32") === "function") return;
	const crcTable = new Uint32Array(256);
	for (let n = 0; n < 256; n++) {
		let c = n;
		for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
		crcTable[n] = c >>> 0;
	}
	Reflect.set(zlib, "crc32", (data: string | NodeJS.ArrayBufferView, value = 0): number => {
		const bytes =
			typeof data === "string"
				? new TextEncoder().encode(data)
				: new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
		let crc = ~value >>> 0;
		for (const byte of bytes) crc = (crcTable[(crc ^ byte) & 0xff] ?? 0) ^ (crc >>> 8);
		return ~crc >>> 0;
	});
}
