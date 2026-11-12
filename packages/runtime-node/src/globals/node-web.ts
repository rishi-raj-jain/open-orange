import { inspect, type InspectOptions } from "node:util";

import type { CryptoImplementation, CryptoKeyValue, SubtleCryptoValue } from "./crypto.js";
import type { PerformanceValue } from "./native.js";
import { installNodePolyfills } from "./node-polyfills.js";

installNodePolyfills();

// Node.js already provides these Web platform globals with the same shape as
// workerd. Capture them before the Cloudflare global installer replaces the
// process-wide properties, so Orange installs the Node values instead of
// throwing placeholders.
function nodeGlobal(name: string): Function {
	const value: unknown = Reflect.get(globalThis, name);
	if (typeof value !== "function") {
		throw new Error(`Node.js does not provide the required ${name} global`);
	}
	return value;
}

function typedNodeGlobal<Name extends keyof typeof globalThis>(
	name: Name,
): (typeof globalThis)[Name] {
	const value = globalThis[name];
	if (typeof value !== "function") {
		throw new Error(`Node.js does not provide the required ${name} global`);
	}
	return value;
}

// The typed views below use local shapes so that emitted declarations do not
// depend on @types/node.
export interface NodeEventTargetValue {
	addEventListener(type: string, listener: unknown, options?: object | boolean): void;
	dispatchEvent(event: unknown): boolean;
	removeEventListener(type: string, listener: unknown, options?: object | boolean): void;
}

export interface NodeEventTargetConstructor {
	readonly prototype: NodeEventTargetValue;
	new (): NodeEventTargetValue;
}

// Typed views of the same Node.js values held in nodeWebGlobals.
export const NodeEventTarget: NodeEventTargetConstructor = typedNodeGlobal("EventTarget");
const NodeFile = typedNodeGlobal("File");
export const NodeURLPattern: typeof URLPattern = typedNodeGlobal("URLPattern");

/** A Web IDL interface object whose instances are created only by the runtime. */
export interface RuntimeOnlyConstructor<Instance> {
	readonly prototype: Instance;
	new (): Instance;
}

function runtimeOnlyConstructor<Instance>(name: string): RuntimeOnlyConstructor<Instance> {
	// SAFETY: Node.js defines this interface object, but @types/node does not
	// declare it as a global. Each Instance is the type Orange already uses for the
	// matching Node.js object, such as globalThis.crypto for Crypto.
	return nodeGlobal(name) as RuntimeOnlyConstructor<Instance>;
}

// The declared types name the globals instead of expanding Node.js types, so
// the emitted declarations resolve against the Cloudflare types in Worker code.
export const nodeWebGlobals: {
	ByteLengthQueuingStrategy: typeof ByteLengthQueuingStrategy;
	CloseEvent: typeof CloseEvent;
	CompressionStream: typeof CompressionStream;
	CountQueuingStrategy: typeof CountQueuingStrategy;
	Crypto: RuntimeOnlyConstructor<CryptoImplementation>;
	CryptoKey: RuntimeOnlyConstructor<CryptoKeyValue>;
	CustomEvent: typeof CustomEvent;
	DecompressionStream: typeof DecompressionStream;
	EventTarget: typeof EventTarget;
	File: typeof File;
	Performance: RuntimeOnlyConstructor<PerformanceValue>;
	ReadableByteStreamController: typeof ReadableByteStreamController;
	ReadableStreamBYOBReader: typeof ReadableStreamBYOBReader;
	ReadableStreamBYOBRequest: typeof ReadableStreamBYOBRequest;
	ReadableStreamDefaultController: typeof ReadableStreamDefaultController;
	ReadableStreamDefaultReader: typeof ReadableStreamDefaultReader;
	SubtleCrypto: RuntimeOnlyConstructor<SubtleCryptoValue>;
	TextDecoderStream: typeof TextDecoderStream;
	TextEncoderStream: typeof TextEncoderStream;
	TransformStreamDefaultController: typeof TransformStreamDefaultController;
	URLPattern: typeof URLPattern;
	WritableStreamDefaultController: typeof WritableStreamDefaultController;
	WritableStreamDefaultWriter: typeof WritableStreamDefaultWriter;
} = {
	ByteLengthQueuingStrategy: typedNodeGlobal("ByteLengthQueuingStrategy"),
	CloseEvent: typedNodeGlobal("CloseEvent"),
	CompressionStream: typedNodeGlobal("CompressionStream"),
	CountQueuingStrategy: typedNodeGlobal("CountQueuingStrategy"),
	Crypto: runtimeOnlyConstructor("Crypto"),
	CryptoKey: runtimeOnlyConstructor("CryptoKey"),
	CustomEvent: typedNodeGlobal("CustomEvent"),
	DecompressionStream: typedNodeGlobal("DecompressionStream"),
	EventTarget: typedNodeGlobal("EventTarget"),
	File: typedNodeGlobal("File"),
	Performance: runtimeOnlyConstructor("Performance"),
	ReadableByteStreamController: typedNodeGlobal("ReadableByteStreamController"),
	ReadableStreamBYOBReader: typedNodeGlobal("ReadableStreamBYOBReader"),
	ReadableStreamBYOBRequest: typedNodeGlobal("ReadableStreamBYOBRequest"),
	ReadableStreamDefaultController: typedNodeGlobal("ReadableStreamDefaultController"),
	ReadableStreamDefaultReader: typedNodeGlobal("ReadableStreamDefaultReader"),
	SubtleCrypto: runtimeOnlyConstructor("SubtleCrypto"),
	TextDecoderStream: typedNodeGlobal("TextDecoderStream"),
	TextEncoderStream: typedNodeGlobal("TextEncoderStream"),
	TransformStreamDefaultController: typedNodeGlobal("TransformStreamDefaultController"),
	URLPattern: typedNodeGlobal("URLPattern"),
	WritableStreamDefaultController: typedNodeGlobal("WritableStreamDefaultController"),
	WritableStreamDefaultWriter: typedNodeGlobal("WritableStreamDefaultWriter"),
};

// workerd lists File's own fields before the inherited Blob fields.
// https://github.com/cloudflare/workerd/blob/b73ce3ae105c35bafaaad864095079524573a465/src/workerd/api/tests/blob-test.js#L143-L157
export function installFileInspect(): void {
	const prototype = NodeFile.prototype;
	Object.defineProperty(prototype, Symbol.for("nodejs.util.inspect.custom"), {
		configurable: true,
		enumerable: false,
		writable: true,
		value(this: File, depth: number, options: InspectOptions): unknown {
			if (depth < 0) return this;
			const { lastModified, name, size, type } = this;
			return `File ${inspect(
				{ name, lastModified, size, type },
				{ ...options, depth: options.depth == null ? null : options.depth - 1 },
			)}`;
		},
	});
}
