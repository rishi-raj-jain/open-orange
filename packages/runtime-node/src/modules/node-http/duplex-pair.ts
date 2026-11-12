// `duplexPair` arrived in Node.js 22.6, and the agentOS VM runs Node.js 22.0.
// This port of Node.js 24's `lib/internal/streams/duplexpair.js` is used only
// when node:stream lacks it.

import * as stream from "node:stream";
import { Duplex, type DuplexOptions } from "node:stream";

type WriteCallback = (error?: Error | null) => void;

class DuplexSide extends Duplex {
	#otherSide: DuplexSide | null = null;
	#callback: WriteCallback | null = null;

	link(otherSide: DuplexSide): void {
		this.#otherSide = otherSide;
	}

	override _read(): void {
		const callback = this.#callback;
		if (callback !== null) {
			this.#callback = null;
			callback();
		}
	}

	override _write(chunk: Uint8Array, _encoding: BufferEncoding, callback: WriteCallback): void {
		const otherSide = this.#otherSide;
		if (otherSide === null) throw new Error("duplexPair side is not linked.");
		if (chunk.length === 0) {
			process.nextTick(callback);
			return;
		}
		otherSide.push(chunk);
		otherSide.#callback = callback;
	}

	override _final(callback: WriteCallback): void {
		const otherSide = this.#otherSide;
		if (otherSide === null) throw new Error("duplexPair side is not linked.");
		otherSide.on("end", callback);
		otherSide.push(null);
	}

	override _destroy(error: Error | null, callback: WriteCallback): void {
		const otherSide = this.#otherSide;
		if (otherSide !== null && !otherSide.destroyed) {
			// Defer so a destroy from inside the HTTP parser does not re-enter it.
			process.nextTick(() => {
				if (otherSide.destroyed) return;
				// Close the other side without its error, so it does not hang and
				// does not raise an unhandled error.
				if (error) otherSide.destroy();
				else otherSide.push(null);
			});
		}
		callback(error);
	}
}

function duplexPairFallback(options?: DuplexOptions): [Duplex, Duplex] {
	const side0 = new DuplexSide(options);
	const side1 = new DuplexSide(options);
	side0.link(side1);
	side1.link(side0);
	return [side0, side1];
}

export const duplexPair: (options?: DuplexOptions) => [Duplex, Duplex] =
	Reflect.get(stream, "duplexPair") ?? duplexPairFallback;
