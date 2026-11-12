export function splitOption(token: string): { name: string; value?: string } {
	const separator = token.indexOf("=");
	return separator === -1
		? { name: token }
		: { name: token.slice(0, separator), value: token.slice(separator + 1) };
}

export function optionValue(
	args: readonly string[],
	index: number,
	name: string,
	inlineValue: string | undefined,
): { index: number; value: string } {
	if (inlineValue !== undefined) {
		if (inlineValue.length === 0) {
			throw new Error(`${name} requires a value`);
		}
		return { index, value: inlineValue };
	}
	const value = args[index + 1];
	if (value === undefined || value.startsWith("-")) {
		throw new Error(`${name} requires a value`);
	}
	return { index: index + 1, value };
}

export function booleanValue(name: string, value: string | undefined): boolean {
	if (value === undefined || value === "true") {
		return true;
	}
	if (value === "false") {
		return false;
	}
	throw new Error(`${name} must be true or false`);
}
