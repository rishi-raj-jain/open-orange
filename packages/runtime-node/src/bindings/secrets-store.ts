import { runtimeSettings } from "../internal/runtime-settings.js";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

export interface SecretsStoreSecret {
	get(): Promise<string>;
}

export interface SecretSource {
	resolve(bindingName: string): Promise<string | undefined>;
}

export interface LocalSecretSourceOptions {
	directory: string;
	environment?: Readonly<Record<string, string | undefined>>;
}

function decodeDoubleQuoted(value: string): string {
	let decoded = "";
	for (let index = 0; index < value.length; index += 1) {
		const character = value[index];
		if (character !== "\\") {
			decoded += character;
			continue;
		}
		index += 1;
		const escaped = value[index];
		if (escaped === undefined) {
			decoded += "\\";
		} else if (escaped === "n") {
			decoded += "\n";
		} else if (escaped === "r") {
			decoded += "\r";
		} else if (escaped === "t") {
			decoded += "\t";
		} else {
			decoded += escaped;
		}
	}
	return decoded;
}

function unquotedValue(value: string): string {
	for (let index = 0; index < value.length; index += 1) {
		if (value[index] === "#" && (index === 0 || /\s/.test(value[index - 1] ?? ""))) {
			return value.slice(0, index).trimEnd();
		}
	}
	return value.trimEnd();
}

function parseValue(value: string): string {
	const trimmed = value.trim();
	if (trimmed.length >= 2 && trimmed.startsWith("'") && trimmed.endsWith("'")) {
		return trimmed.slice(1, -1);
	}
	if (trimmed.length >= 2 && trimmed.startsWith('"') && trimmed.endsWith('"')) {
		return decodeDoubleQuoted(trimmed.slice(1, -1));
	}
	return unquotedValue(value.trimStart());
}

// A quoted value that has no closing quote on its line continues on the next
// lines, as in dotenv, which Wrangler uses. A PEM key written with real line
// breaks is one value.
// https://github.com/motdotla/dotenv/blob/603ae186b68a4a58b4bafa9ab65fe7c3f6685e0e/lib/main.js#L9
function openQuote(value: string): string | undefined {
	const trimmed = value.trimStart();
	const quote = trimmed[0];
	if (quote !== '"' && quote !== "'") return undefined;
	for (let index = 1; index < trimmed.length; index += 1) {
		if (trimmed[index] === "\\" && quote === '"') {
			index += 1;
		} else if (trimmed[index] === quote) {
			return undefined;
		}
	}
	return quote;
}

export function parseDevVars(source: string): Map<string, string> {
	const values = new Map<string, string>();
	const lines = source.replaceAll("\r\n", "\n").split("\n");
	for (let index = 0; index < lines.length; index += 1) {
		const line = (lines[index] ?? "").trim();
		if (line.length === 0 || line.startsWith("#")) {
			continue;
		}
		const declaration = line.startsWith("export ") ? line.slice(7).trimStart() : line;
		const separator = declaration.indexOf("=");
		const key = separator === -1 ? "" : declaration.slice(0, separator).trim();
		if (separator === -1 || !/^[A-Z_a-z][\w]*$/.test(key)) {
			throw new Error(`Invalid .dev.vars declaration on line ${index + 1}`);
		}
		let value = declaration.slice(separator + 1);
		const quote = openQuote(value);
		if (quote !== undefined) {
			const start = index;
			let closed = false;
			while (!closed && index + 1 < lines.length) {
				index += 1;
				const next = lines[index] ?? "";
				value += `\n${next}`;
				closed = next.trimEnd().endsWith(quote);
			}
			if (!closed) {
				throw new Error(`Unclosed quoted .dev.vars value on line ${start + 1}`);
			}
		}
		values.set(key, parseValue(value));
	}
	return values;
}

function isMissingFile(error: unknown): boolean {
	return (
		typeof error === "object" &&
		error !== null &&
		"code" in error &&
		error.code === "ENOENT"
	);
}

export function createLocalSecretSource(
	options: LocalSecretSourceOptions,
): SecretSource {
	const environment = options.environment ?? runtimeSettings();
	let fileValues: Promise<Map<string, string>> | undefined;
	async function values(): Promise<Map<string, string>> {
		fileValues ??= readFile(join(options.directory, ".dev.vars"), "utf8")
			.then(parseDevVars)
			.catch((error: unknown) => {
				if (isMissingFile(error)) {
					return new Map<string, string>();
				}
				throw error;
			});
		return fileValues;
	}

	return {
		async resolve(bindingName: string): Promise<string | undefined> {
			const fromFile = (await values()).get(bindingName);
			return fromFile ?? environment[bindingName];
		},
	};
}

const secretBindings = new WeakMap<SecretsStoreSecret, {
	bindingName: string;
	source: SecretSource;
}>();

class LocalSecretsStoreSecret implements SecretsStoreSecret {
	async get(): Promise<string> {
		const state = secretBindings.get(this);
		if (state === undefined) {
			throw new TypeError("Illegal invocation");
		}
		const value = await state.source.resolve(state.bindingName);
		if (value === undefined) {
			throw new Error(
				`Secrets Store binding ${JSON.stringify(state.bindingName)} is not configured locally`,
			);
		}
		return value;
	}
}

export function createSecretsStoreSecret(
	bindingName: string,
	source: SecretSource,
): SecretsStoreSecret {
	const binding = new LocalSecretsStoreSecret();
	secretBindings.set(binding, { bindingName, source });
	return binding;
}
