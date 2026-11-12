// Predicate for values that cross into the CLI untyped: JSON bodies and
// configuration objects returned by other tools.
export function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
