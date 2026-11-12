import { File } from "node:buffer";
import { URLSearchParams } from "node:url";

import { FormData } from "undici";

// Workerd parses bodies as raw bytes. Latin-1 keeps one character per byte so
// that offsets found in the text are byte offsets.
function bytesToBinary(bytes: Uint8Array): string {
	return Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString("latin1");
}

function binaryToUtf8(text: string): string {
	return Buffer.from(text, "latin1").toString("utf8");
}

interface MimeType {
	essence: string;
	params: Map<string, string>;
}

function parseMimeType(value: string): MimeType | undefined {
	const [essenceText = "", ...rest] = value.split(";");
	const essence = essenceText.trim().toLowerCase();
	if (!/^[!#$%&'*+.^_`|~0-9a-z-]+\/[!#$%&'*+.^_`|~0-9a-z-]+$/.test(essence)) {
		return undefined;
	}
	const params = new Map<string, string>();
	for (const entry of rest) {
		const separator = entry.indexOf("=");
		if (separator === -1) continue;
		const name = entry.slice(0, separator).trim().toLowerCase();
		let paramValue = entry.slice(separator + 1).trim();
		if (paramValue.startsWith('"')) {
			paramValue = paramValue
				.slice(1, paramValue.endsWith('"') ? -1 : undefined)
				.replace(/\\(.)/g, "$1");
		} else if (paramValue.length === 0) {
			// WHATWG MIME parsing drops an empty unquoted value.
			continue;
		}
		if (name.length > 0 && !params.has(name)) params.set(name, paramValue);
	}
	return { essence, params };
}

function parseHeaders(text: string): Map<string, string> | undefined {
	const headers = new Map<string, string>();
	for (const line of text.split(/\r?\n/)) {
		if (line.length === 0) continue;
		const separator = line.indexOf(":");
		if (separator <= 0) return undefined;
		const name = line.slice(0, separator);
		if (!/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(name)) return undefined;
		const key = name.toLowerCase();
		const value = line.slice(separator + 1).trim();
		headers.set(key, headers.has(key) ? `${headers.get(key)}, ${value}` : value);
	}
	return headers;
}

const identifierChar = /[A-Za-z0-9_-]/;

// Mirrors workerd's Content-Disposition grammar: an identifier followed by
// `; name="value"` parameters, where a backslash escapes any character but LF.
// Trailing input that does not match is ignored, as in kj::parse.
// https://github.com/cloudflare/workerd/blob/b73ce3ae105c35bafaaad864095079524573a465/src/workerd/api/form-data.c%2B%2B#L51-L66
function parseContentDisposition(
	text: string,
): { kind: string; params: [string, string][] } | undefined {
	let index = 0;
	const skipWhitespace = (): void => {
		while (index < text.length && /[ \t\r\n]/.test(text[index] ?? "")) index++;
	};
	const identifier = (): string | undefined => {
		const start = index;
		while (index < text.length && identifierChar.test(text[index] ?? "")) index++;
		return index > start ? text.slice(start, index) : undefined;
	};
	skipWhitespace();
	const kind = identifier();
	if (kind === undefined) return undefined;
	skipWhitespace();
	const params: [string, string][] = [];
	for (;;) {
		const start = index;
		const param = ((): [string, string] | undefined => {
			if (text[index] !== ";") return undefined;
			index++;
			skipWhitespace();
			const name = identifier();
			if (name === undefined) return undefined;
			skipWhitespace();
			if (text[index] !== "=") return undefined;
			index++;
			skipWhitespace();
			if (text[index] !== '"') return undefined;
			index++;
			let value = "";
			for (;;) {
				const char = text[index];
				if (char === undefined || char === "\n") return undefined;
				if (char === '"') break;
				if (char === "\\") {
					const escaped = text[index + 1];
					if (escaped === undefined || escaped === "\n") return undefined;
					value += escaped;
					index += 2;
				} else {
					value += char;
					index++;
				}
			}
			if (value.length === 0) return undefined;
			index++;
			skipWhitespace();
			return [name, value];
		})();
		if (param === undefined) {
			index = start;
			break;
		}
		params.push(param);
	}
	return { kind, params };
}

function splitAtSubstring(text: string, separator: string): [string, string] {
	const index = text.indexOf(separator);
	if (index === -1) return [text, ""];
	return [text.slice(0, index), text.slice(index + separator.length)];
}

// Mirrors workerd's multipart/form-data parser, which accepts LF as well as
// CRLF line endings.
// https://github.com/cloudflare/workerd/blob/b73ce3ae105c35bafaaad864095079524573a465/src/workerd/api/form-data.c%2B%2B#L150-L249
function parseMultipart(raw: string, boundary: string, formData: FormData): void {
	const delimiter = `\n--${boundary}`;
	let [, rest] = splitAtSubstring(raw, delimiter.slice(1));
	if (rest.length === 0) {
		throw new TypeError("No initial boundary string (or you have a truncated message).");
	}
	const done = (): boolean => {
		if (rest.startsWith("\n")) {
			rest = rest.slice(1);
		} else if (rest.startsWith("\r\n")) {
			rest = rest.slice(2);
		} else if (rest.startsWith("--")) {
			return true;
		} else {
			throw new TypeError("Boundary string was not succeeded by CRLF, LF, or '--'.");
		}
		return false;
	};
	while (!done()) {
		const termination = /\r?\n\r?\n/.exec(rest);
		if (termination === null) {
			throw new TypeError("No multipart message header termination found.");
		}
		const headerEnd = termination.index + termination[0].length;
		const headers = parseHeaders(rest.slice(0, headerEnd));
		rest = rest.slice(headerEnd);
		if (headers === undefined) {
			throw new TypeError("FormData part had invalid headers.");
		}
		const disposition = headers.get("content-disposition");
		if (disposition === undefined) {
			throw new TypeError("No valid Content-Disposition header found in FormData part.");
		}
		const parsed = parseContentDisposition(disposition);
		if (parsed === undefined) {
			throw new TypeError("Invalid Content-Disposition header found in FormData part.");
		}
		if (parsed.kind !== "form-data") {
			throw new TypeError(
				`Content-Disposition header for FormData part must have the value "form-data", possibly followed by parameters. Got: "${parsed.kind}"`,
			);
		}
		let name: string | undefined;
		let filename: string | undefined;
		for (const [key, value] of parsed.params) {
			if (key === "name") name = value;
			else if (key === "filename") filename = value;
		}
		if (name === undefined) {
			throw new TypeError("Content-Disposition header in FormData part is missing a name.");
		}
		let message: string;
		[message, rest] = splitAtSubstring(rest, delimiter);
		if (rest.length === 0) {
			throw new TypeError("No subsequent boundary string after multipart message.");
		}
		if (message.endsWith("\r")) message = message.slice(0, -1);
		if (filename === undefined) {
			formData.append(binaryToUtf8(name), binaryToUtf8(message));
		} else {
			const file = new File([Buffer.from(message, "latin1")], binaryToUtf8(filename), {
				type: headers.get("content-type") ?? "",
			});
			formData.append(binaryToUtf8(name), file);
		}
	}
}

// Mirrors workerd's Body.formData(): a Content-Type is required and only
// multipart/form-data and application/x-www-form-urlencoded parse.
// https://github.com/cloudflare/workerd/blob/b73ce3ae105c35bafaaad864095079524573a465/src/workerd/api/form-data.c%2B%2B#L251-L309
export function parseFormDataBody(
	bytes: Uint8Array,
	contentType: string | null,
): FormData {
	if (contentType === null) {
		throw new TypeError("Parsing a Body as FormData requires a Content-Type header.");
	}
	const formData = new FormData();
	const mimeType = parseMimeType(contentType);
	if (mimeType?.essence === "multipart/form-data") {
		const boundary = mimeType.params.get("boundary");
		if (boundary === undefined) {
			throw new TypeError(
				"No boundary string in Content-Type header. The multipart/form-data MIME type requires a boundary parameter, e.g. 'Content-Type: multipart/form-data; boundary=\"abcd\"'. See RFC 7578, section 4.",
			);
		}
		parseMultipart(bytesToBinary(bytes), boundary, formData);
		return formData;
	}
	if (mimeType?.essence === "application/x-www-form-urlencoded") {
		const charset = mimeType.params.get("charset")?.toLowerCase();
		if (
			charset !== undefined &&
			charset !== "utf-8" &&
			charset !== "utf8" &&
			charset !== "unicode-1-1-utf-8"
		) {
			throw new TypeError("Non-utf-8 application/x-www-form-urlencoded body.");
		}
		for (const [name, value] of new URLSearchParams(Buffer.from(bytes).toString("utf8"))) {
			formData.append(name, value);
		}
		return formData;
	}
	throw new TypeError(
		"Unrecognized Content-Type header value. FormData can only parse the following MIME types: multipart/form-data, application/x-www-form-urlencoded",
	);
}
