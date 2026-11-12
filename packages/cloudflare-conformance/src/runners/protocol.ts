export type NormalizedValue =
	| null
	| boolean
	| number
	| string
	| NormalizedValue[]
	| { [key: string]: NormalizedValue };

export type FixtureOutcome =
	| { type: "value"; value: NormalizedValue }
	| { type: "error"; error: { name: string; message: string } };

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function normalizeValue(value: unknown): NormalizedValue {
	if (
		value === null ||
		typeof value === "boolean" ||
		typeof value === "string"
	) {
		return value;
	}
	if (typeof value === "number" && Number.isFinite(value)) {
		return value;
	}
	if (Array.isArray(value)) {
		return value.map(normalizeValue);
	}
	if (isRecord(value)) {
		const normalized: Record<string, NormalizedValue> = {};
		for (const key of Object.keys(value).sort()) {
			normalized[key] = normalizeValue(value[key]);
		}
		return normalized;
	}
	throw new Error(`Fixture returned a non-JSON value of type ${typeof value}`);
}

export function parseFixtureOutcome(value: unknown): FixtureOutcome {
	if (!isRecord(value)) {
		throw new Error("Fixture outcome must be an object");
	}
	if (value.type === "value" && "value" in value) {
		return { type: "value", value: normalizeValue(value.value) };
	}
	if (value.type === "error" && isRecord(value.error)) {
		if (
			typeof value.error.name === "string" &&
			typeof value.error.message === "string"
		) {
			return {
				type: "error",
				error: {
					message: value.error.message,
					name: value.error.name,
				},
			};
		}
	}
	throw new Error("Fixture outcome must contain a valid value or error envelope");
}
