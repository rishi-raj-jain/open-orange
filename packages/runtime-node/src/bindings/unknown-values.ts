// Predicates for values that cross a trust boundary into the runtime: arguments
// from untyped Worker code, JSON from a provider or the Engine, or rows read back
// from storage.

export function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

// Accepts arrays and class instances such as `Headers`, which Cloudflare also
// accepts where an options object is expected.
export function isObject(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

export function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
