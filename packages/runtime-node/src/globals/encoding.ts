import {
	TextDecoder as NodeTextDecoder,
	TextEncoder as NodeTextEncoder,
} from "node:util";

interface DecoderConstructorOptions {
	fatal: boolean;
	ignoreBOM: boolean;
}

interface DecoderDecodeOptions {
	stream: boolean;
}

interface EncoderEncodeIntoResult {
	read: number;
	written: number;
}

const decoders = new WeakMap<TextDecoder, NodeTextDecoder>();
const encoders = new WeakMap<TextEncoder, NodeTextEncoder>();

function decoderFor(instance: TextDecoder): NodeTextDecoder {
	const decoder = decoders.get(instance);
	if (decoder === undefined) {
		throw new TypeError("Illegal invocation");
	}
	return decoder;
}

function encoderFor(instance: TextEncoder): NodeTextEncoder {
	const encoder = encoders.get(instance);
	if (encoder === undefined) {
		throw new TypeError("Illegal invocation");
	}
	return encoder;
}

function decoderInput(
	input: ArrayBuffer | ArrayBufferView | undefined,
): ArrayBuffer | Uint8Array | undefined {
	if (input === undefined || input instanceof ArrayBuffer) {
		return input;
	}
	return new Uint8Array(input.buffer, input.byteOffset, input.byteLength);
}

export class TextDecoder {
	constructor(label?: string, options?: DecoderConstructorOptions) {
		try {
			decoders.set(this, new NodeTextDecoder(label, options));
		} catch (error: unknown) {
			if (error instanceof RangeError && label !== undefined) {
				throw new RangeError(`"${label}" is not a valid encoding.`);
			}
			throw error;
		}
	}

	decode(
		input?: ArrayBuffer | ArrayBufferView,
		options?: DecoderDecodeOptions,
	): string {
		try {
			return decoderFor(this).decode(decoderInput(input), options);
		} catch (error: unknown) {
			if (error instanceof TypeError) {
				throw new TypeError("Failed to decode input.");
			}
			throw error;
		}
	}

	get encoding(): string {
		return decoderFor(this).encoding;
	}

	get fatal(): boolean {
		return decoderFor(this).fatal;
	}

	get ignoreBOM(): boolean {
		return decoderFor(this).ignoreBOM;
	}
}

export class TextEncoder {
	constructor() {
		encoders.set(this, new NodeTextEncoder());
	}

	encode(input?: string): Uint8Array {
		return encoderFor(this).encode(input);
	}

	encodeInto(input: string, buffer: Uint8Array): EncoderEncodeIntoResult {
		return encoderFor(this).encodeInto(input, buffer);
	}

	get encoding(): string {
		return encoderFor(this).encoding;
	}
}
