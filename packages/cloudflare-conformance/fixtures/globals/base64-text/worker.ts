function capture(callback) {
	try {
		return { type: "value", value: callback() };
	} catch (error) {
		return {
			type: "error",
			error: {
				name: error instanceof Error ? error.name : "Error",
				message: error instanceof Error ? error.message : String(error),
			},
		};
	}
}

function base64Observations() {
	return {
		atobBasic: atob("SGVsbG8="),
		atobWhitespace: atob(" YQ == \n"),
		atobUnpadded: atob("YQ"),
		atobInvalid: capture(() => atob("%%%")),
		btoaLatin1: btoa("hello\0ÿ"),
		btoaUnicode: capture(() => btoa("✓")),
	};
}

function encodingObservations() {
	const encoder = new TextEncoder();
	const destination = new Uint8Array(4);
	const progress = encoder.encodeInto("A💩B", destination);
	const decoder = new TextDecoder();
	const streamFirst = decoder.decode(new Uint8Array([0xe2, 0x82]), {
		stream: true,
	});
	const streamSecond = decoder.decode(new Uint8Array([0xac]), { stream: false });
	const fatal = new TextDecoder("utf-8", {
		fatal: true,
		ignoreBOM: false,
	});

	return {
		decoder: {
			encoding: decoder.encoding,
			fatal: decoder.fatal,
			ignoreBOM: decoder.ignoreBOM,
			bom: decoder.decode(new Uint8Array([0xef, 0xbb, 0xbf, 0x41])),
			fatalInvalid: capture(() => fatal.decode(new Uint8Array([0xff]))),
			stream: [streamFirst, streamSecond],
		},
		invalidLabel: capture(() => new TextDecoder("not-an-encoding")),
		encoder: {
			bytes: [...encoder.encode("A💩")],
			encoding: encoder.encoding,
			into: {
				bytes: [...destination],
				read: progress.read,
				written: progress.written,
			},
		},
	};
}

export default {
	async fetch(request) {
		try {
			const testCase = new URL(request.url).searchParams.get("case");
			const value =
				testCase === "base64"
					? base64Observations()
					: testCase === "encoding"
						? encodingObservations()
						: (() => {
								throw new Error(`Unknown base64/text fixture case: ${testCase}`);
							})();
			return Response.json({ type: "value", value });
		} catch (error) {
			return Response.json({
				type: "error",
				error: {
					name: error instanceof Error ? error.name : "Error",
					message: error instanceof Error ? error.message : String(error),
				},
			});
		}
	},
};
