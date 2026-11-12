import "../globals/stream-compat.js";

// Orange's own stream plumbing calls these copies, taken before a Worker runs. A Worker can replace
// the public prototypes' methods, and that must not intercept or fake a transfer, as on workerd.
// https://github.com/cloudflare/workerd/blob/b73ce3ae105c35bafaaad864095079524573a465/src/workerd/api/tests/js-rpc-streams-pollution-test.js
const getReaderMethod: Function = ReadableStream.prototype.getReader;
const getWriterMethod: Function = WritableStream.prototype.getWriter;
const writerWriteMethod: Function = WritableStreamDefaultWriter.prototype.write;
const writerCloseMethod: Function = WritableStreamDefaultWriter.prototype.close;
const writerAbortMethod: Function = WritableStreamDefaultWriter.prototype.abort;

export function readerOf<Chunk>(stream: ReadableStream<Chunk>): ReadableStreamDefaultReader<Chunk> {
	return Reflect.apply(getReaderMethod, stream, []) as ReadableStreamDefaultReader<Chunk>;
}

export function writerOf<Chunk>(stream: WritableStream<Chunk>): WritableStreamDefaultWriter<Chunk> {
	return Reflect.apply(getWriterMethod, stream, []) as WritableStreamDefaultWriter<Chunk>;
}

export function writeTo<Chunk>(writer: WritableStreamDefaultWriter<Chunk>, chunk: Chunk): Promise<void> {
	return Reflect.apply(writerWriteMethod, writer, [chunk]) as Promise<void>;
}

export function closeWriter(writer: WritableStreamDefaultWriter<unknown>): Promise<void> {
	return Reflect.apply(writerCloseMethod, writer, []) as Promise<void>;
}

export function abortWriter(writer: WritableStreamDefaultWriter<unknown>, reason: unknown): Promise<void> {
	return Reflect.apply(writerAbortMethod, writer, [reason]) as Promise<void>;
}

/**
 * For a writable that Orange hands to Cap'n Web, which calls the public methods. A transferred stream
 * is locked from then on, so these own methods only change who a transfer calls.
 */
export function withInternalWriter<Chunk>(stream: WritableStream<Chunk>): WritableStream<Chunk> {
	Object.defineProperty(stream, "getWriter", {
		configurable: true,
		value() {
			const writer = writerOf(stream);
			Object.defineProperties(writer, {
				abort: { configurable: true, value: (reason: unknown) => abortWriter(writer, reason) },
				close: { configurable: true, value: () => closeWriter(writer) },
				write: { configurable: true, value: (chunk: Chunk) => writeTo(writer, chunk) },
			});
			return writer;
		},
	});
	return stream;
}
