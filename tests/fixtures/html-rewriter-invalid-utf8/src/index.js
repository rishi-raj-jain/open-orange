// Prepends streamed content to <p> and reports what the rewritten body reads as.
async function rewrite(content) {
	const page = new Response("<p>x</p>", { headers: { "content-type": "text/html" } });
	const response = new HTMLRewriter()
		.on("p", {
			element(element) {
				element.prepend(content());
			},
		})
		.transform(page);
	try {
		return { text: await response.text() };
	} catch (error) {
		return { error: `${error.name}: ${error.message}` };
	}
}

// A two-byte character split across chunks is valid UTF-8.
function splitCharacter() {
	const bytes = new TextEncoder().encode("é!");
	return new ReadableStream({
		start(controller) {
			controller.enqueue(bytes.slice(0, 1));
			controller.enqueue(bytes.slice(1));
			controller.close();
		},
	});
}

export default {
	async fetch() {
		return Response.json({
			invalidResponse: await rewrite(() => new Response(new Uint8Array([0x67, 0xe2, 0x28, 0xa1]))),
			truncatedStream: await rewrite(() => new Response(new Uint8Array([0x61, 0xe2, 0x82]))),
			splitCharacter: await rewrite(splitCharacter),
		});
	},
};
