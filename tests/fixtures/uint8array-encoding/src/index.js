import { runProbe } from "./probe.js";

function attempt(run) {
	try {
		const value = run();
		return value instanceof Uint8Array ? [...value] : value;
	} catch (error) {
		return error.name;
	}
}

function detached() {
	const bytes = new Uint8Array([1, 2]);
	structuredClone(bytes.buffer, { transfer: [bytes.buffer] });
	return bytes;
}

export default {
	fetch(request) {
		const url = new URL(request.url);
		if (url.pathname === "/probe") return Response.json(runProbe());
		// Each encoding allocates only its result and a fixed buffer.
		if (url.pathname === "/large") {
			const bytes = new Uint8Array(Number(url.searchParams.get("mib")) * 1024 * 1024).fill(171);
			const hex = bytes.toHex();
			const base64 = bytes.toBase64();
			return Response.json({ hex: hex.length, hexEnd: hex.slice(-4), base64: base64.length, base64End: base64.slice(-4) });
		}
		const whole = new Uint8Array([0, 1, 2, 255, 254, 3]);
		// The view starts past byte 0 of its buffer. Node's `--js-base-64` gets this wrong.
		const subarray = whole.subarray(2, 5);
		const pooled = Buffer.from([1, 2, 255]);
		return Response.json({
			pooledBuffer: { hex: pooled.toHex(), base64: pooled.toBase64() },
			subarray: { hex: subarray.toHex(), base64: subarray.toBase64() },
			hex: {
				empty: new Uint8Array().toHex(),
				fromMixedCase: attempt(() => Uint8Array.fromHex("01aBfF")),
				fromOddLength: attempt(() => Uint8Array.fromHex("abc")),
				fromNonHex: attempt(() => Uint8Array.fromHex("zz")),
				fromNonString: attempt(() => Uint8Array.fromHex(1)),
				wrongReceiver: attempt(() => Uint8Array.prototype.toHex.call(new Int8Array(1))),
				detached: attempt(() => detached().toHex()),
			},
			base64: {
				padded: new Uint8Array([1, 2]).toBase64(),
				omitPadding: new Uint8Array([1, 2]).toBase64({ omitPadding: true }),
				url: new Uint8Array([251, 255]).toBase64({ alphabet: "base64url" }),
				badAlphabet: attempt(() => new Uint8Array(1).toBase64({ alphabet: "hex" })),
				detached: attempt(() => detached().toBase64()),
				fromWhitespace: attempt(() => Uint8Array.fromBase64(" AQ\nI= ")),
				fromLooseNoPadding: attempt(() => Uint8Array.fromBase64("AQI")),
				fromStrictNoPadding: attempt(() => Uint8Array.fromBase64("AQI", { lastChunkHandling: "strict" })),
				fromStrictExtraBits: attempt(() => Uint8Array.fromBase64("AQJ=", { lastChunkHandling: "strict" })),
				fromStopBeforePartial: attempt(() => Uint8Array.fromBase64("AQIDBA", { lastChunkHandling: "stop-before-partial" })),
				fromUrl: attempt(() => Uint8Array.fromBase64("-_8", { alphabet: "base64url" })),
				fromUrlInStandard: attempt(() => Uint8Array.fromBase64("-_8")),
				fromInvalid: attempt(() => Uint8Array.fromBase64("A")),
			},
			shape: {
				enumerable: Object.keys(Uint8Array.prototype).includes("toHex"),
				toBase64Length: Uint8Array.prototype.toBase64.length,
				fromBase64Length: Uint8Array.fromBase64.length,
				constructible: attempt(() => new Uint8Array.fromHex("00")),
			},
		});
	},
};
