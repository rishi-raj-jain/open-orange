const hostAtob = globalThis.atob;
const hostBtoa = globalThis.btoa;
const HostDOMException = globalThis.DOMException;

const invalidAtobMessage =
	"atob() called with invalid base64-encoded data. (Only whitespace, '+', '/', alphanumeric ASCII, and up to two terminal '=' signs when the input data length is divisible by 4 are allowed.)";
const invalidBtoaMessage =
	"btoa() can only operate on characters in the Latin1 (ISO/IEC 8859-1) range.";

function normalizeBase64Error(error: unknown, message: string): never {
	if (error instanceof HostDOMException && error.name === "InvalidCharacterError") {
		throw new HostDOMException(message, "InvalidCharacterError");
	}
	throw error;
}

export function atob(data: string): string {
	try {
		return hostAtob(data);
	} catch (error: unknown) {
		return normalizeBase64Error(error, invalidAtobMessage);
	}
}

export function btoa(data: string): string {
	try {
		return hostBtoa(data);
	} catch (error: unknown) {
		return normalizeBase64Error(error, invalidBtoaMessage);
	}
}
