// Globals that Node.js 24 has and the agentOS VM's Node.js 22 does not. Only
// the agentOS build of the dynamic Worker child injects this file. Each shim
// fills a global only when it is missing.

import * as nodeBuffer from "node:buffer";
import { webcrypto } from "node:crypto";
import * as perfHooks from "node:perf_hooks";
import { Duplex } from "node:stream";
import * as streamWeb from "node:stream/web";
import * as zlib from "node:zlib";

import { installNodePolyfills } from "../../globals/node-polyfills.js";

installNodePolyfills();

// Tells the runtime it runs in the agentOS VM. See `loadWorkerEntrypoint()`.
Reflect.set(globalThis, Symbol.for("open-orange.agentos-vm"), true);

function fill(name: string, value: unknown): void {
	if (value !== undefined && Reflect.get(globalThis, name) === undefined) {
		Reflect.set(globalThis, name, value);
	}
}

// A class that exists for `instanceof` checks and fails when constructed.
function unsupported(name: string): Function {
	return class {
		constructor() {
			throw new Error(`${name} is not available in the agentOS VM.`);
		}
	};
}

for (const [name, value] of Object.entries(streamWeb)) fill(name, value);

type ZlibFormat = "deflate" | "deflate-raw" | "gzip";

function zlibStream(format: unknown, compress: boolean): Duplex {
	switch (format) {
		case "gzip":
			return compress ? zlib.createGzip() : zlib.createGunzip();
		case "deflate":
			return compress ? zlib.createDeflate() : zlib.createInflate();
		case "deflate-raw":
			return compress ? zlib.createDeflateRaw() : zlib.createInflateRaw();
		default:
			throw new TypeError(`Unsupported compression format: ${String(format)}`);
	}
}

// CompressionStream and DecompressionStream on node:zlib.
function zlibTransform(compress: boolean): Function {
	return class {
		readonly readable: ReadableStream<Uint8Array>;
		readonly writable: WritableStream<Uint8Array>;
		constructor(format: ZlibFormat) {
			const pair = Duplex.toWeb(zlibStream(format, compress));
			this.readable = pair.readable;
			this.writable = pair.writable;
		}
	};
}
// The VM does not export the stream controller and reader classes, so read
// them off live instances.
function constructorOf(make: () => unknown): Function | undefined {
	try {
		const value = make();
		return typeof value === "object" && value !== null ? value.constructor : undefined;
	} catch {
		return undefined;
	}
}
fill("DOMException", constructorOf(() => {
	try {
		structuredClone(() => undefined);
	} catch (error: unknown) {
		return error;
	}
	return undefined;
}));
let defaultController: unknown;
const defaultStream = new ReadableStream({ start: (controller) => void (defaultController = controller) });
fill("ReadableStreamDefaultController", constructorOf(() => defaultController));
fill("ReadableStreamDefaultReader", constructorOf(() => defaultStream.getReader()));
let byteController: ReadableByteStreamController | undefined;
const byteStream = new ReadableStream({ start: (controller) => void (byteController = controller), type: "bytes" });
fill("ReadableByteStreamController", constructorOf(() => byteController));
const byobReader = byteStream.getReader({ mode: "byob" });
fill("ReadableStreamBYOBReader", constructorOf(() => byobReader));
byobReader.read(new Uint8Array(1)).catch(() => undefined);
fill("ReadableStreamBYOBRequest", constructorOf(() => byteController?.byobRequest));
byobReader.cancel().catch(() => undefined);
let writableController: unknown;
const writable = new WritableStream({ start: (controller) => void (writableController = controller) });
fill("WritableStreamDefaultController", constructorOf(() => writableController));
fill("WritableStreamDefaultWriter", constructorOf(() => writable.getWriter()));
let transformController: unknown;
new TransformStream({ start: (controller) => void (transformController = controller) });
fill("TransformStreamDefaultController", constructorOf(() => transformController));

fill("CompressionStream", zlibTransform(true));
fill("DecompressionStream", zlibTransform(false));
fill("File", Reflect.get(nodeBuffer, "File"));
fill("Performance", Reflect.get(perfHooks, "Performance") ?? Reflect.get(globalThis, "performance")?.constructor);
fill("Crypto", webcrypto.constructor);
fill("SubtleCrypto", webcrypto.subtle.constructor);
fill("CryptoKey", Reflect.get(webcrypto, "CryptoKey"));
fill("CustomEvent", class CustomEvent<T> extends Event {
	readonly detail: T | null;
	constructor(type: string, init?: { bubbles?: boolean; cancelable?: boolean; composed?: boolean; detail?: T }) {
		super(type, init);
		this.detail = init?.detail ?? null;
	}
});
// The runtime reads these at load time, so a missing one becomes a class
// that fails only when used.
for (const name of [
	"ByteLengthQueuingStrategy",
	"CloseEvent",
	"CompressionStream",
	"CountQueuingStrategy",
	"Crypto",
	"CryptoKey",
	"CustomEvent",
	"DecompressionStream",
	"EventTarget",
	"File",
	"Performance",
	"ReadableByteStreamController",
	"ReadableStream",
	"ReadableStreamBYOBReader",
	"ReadableStreamBYOBRequest",
	"ReadableStreamDefaultController",
	"ReadableStreamDefaultReader",
	"SubtleCrypto",
	"TextDecoderStream",
	"TextEncoderStream",
	"TransformStreamDefaultController",
	"URLPattern",
	"WritableStreamDefaultController",
	"WritableStreamDefaultWriter",
]) {
	fill(name, unsupported(name));
}
const vmPerformance: unknown = Reflect.get(globalThis, "performance");
if (typeof vmPerformance === "object" && vmPerformance !== null) {
	const target = vmPerformance;
	if (typeof Reflect.get(target, "timeOrigin") !== "number") {
		const now: unknown = Reflect.get(target, "now");
		if (typeof now !== "function") throw new TypeError("performance.now is not a function");
		const elapsed: unknown = Reflect.apply(now, target, []);
		Reflect.defineProperty(target, "timeOrigin", {
			configurable: true,
			value: Date.now() - Number(elapsed),
		});
	}
	if (typeof Reflect.get(target, "toJSON") !== "function") {
		Reflect.defineProperty(target, "toJSON", {
			configurable: true,
			value: () => ({ timeOrigin: Reflect.get(target, "timeOrigin") }),
			writable: true,
		});
	}
}
fill("navigator", { userAgent: "Cloudflare-Workers" });
