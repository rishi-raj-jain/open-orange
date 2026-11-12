// Conversions between Fetch requests and responses and Node.js HTTP messages,
// shared by the host node:http shim and the agentOS VM build.

import type { Readable } from "node:stream";

// Fetch joins repeated headers with commas. Node.js keeps only the first value
// of these headers, so workerd splits them again.
// https://github.com/cloudflare/workerd/blob/b73ce3ae105c35bafaaad864095079524573a465/src/node/internal/internal_http_server.ts#L94-L106
export const multipleForbiddenHeaders = new Set([
	"host",
	"content-type",
	"user-agent",
	"referer",
	"authorization",
	"proxy-authorization",
	"if-modified-since",
	"if-unmodified-since",
	"from",
	"location",
	"max-forwards",
]);

// https://github.com/cloudflare/workerd/blob/b73ce3ae105c35bafaaad864095079524573a465/src/node/internal/internal_http_util.ts#L42-L59
function splitHeaderValue(value: string): string {
	let inQuotes = false;
	for (let i = 0; i < value.length; i++) {
		const char = value[i];
		if (char === '"') {
			inQuotes = !inQuotes;
		} else if (char === "\\" && inQuotes) {
			i++;
		} else if (!inQuotes && char === ",") {
			return value.slice(0, i);
		}
	}
	return value;
}

// The request headers as Node.js raw header pairs, with a host header.
export function nodeRequestHeaders(request: Request): string[] {
	const headers: string[] = [];
	request.headers.forEach((value, key) => {
		headers.push(
			key,
			multipleForbiddenHeaders.has(key) ? splitHeaderValue(value) : value,
		);
	});
	if (!request.headers.has("host")) headers.push("host", new URL(request.url).host);
	return headers;
}

export interface NodeResponseHead {
	rawHeaders: readonly string[];
	statusCode?: number | undefined;
	statusMessage?: string | undefined;
}

// Builds the Fetch response for a Node.js response head and body stream. workerd's ServerResponse
// feeds the fetch body directly, so the body ends when the server ends the response, whatever
// its Content-Length said. Here the body passes through an HTTP parser, which reports a short
// body as an error: `responseFinished` tells the two apart from a response the server destroyed.
// https://github.com/cloudflare/workerd/blob/b73ce3ae105c35bafaaad864095079524573a465/src/node/internal/internal_http_server.ts
export function toFetchResponse(
	request: Request,
	head: NodeResponseHead,
	body: Readable,
	responseFinished: () => boolean = () => false,
): Response {
	const responseHeaders = new Headers();
	for (let i = 0; i < head.rawHeaders.length; i += 2) {
		responseHeaders.append(head.rawHeaders[i] ?? "", head.rawHeaders[i + 1] ?? "");
	}
	const status = head.statusCode ?? 500;
	const nullBody =
		request.method === "HEAD" || [101, 204, 205, 304].includes(status);
	const stream = nullBody
		? null
		: new ReadableStream<Uint8Array>({
				start(controller) {
					body.on("data", (chunk: Buffer) =>
						controller.enqueue(new Uint8Array(chunk)),
					);
					body.on("end", () => controller.close());
					body.on("error", (error) => {
						if (responseFinished()) controller.close();
						else controller.error(error);
					});
				},
				cancel() {
					body.destroy();
				},
			});
	return new Response(stream, {
		headers: responseHeaders,
		status,
		statusText: head.statusMessage ?? "",
	});
}
