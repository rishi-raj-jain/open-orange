import helpInventory from "../packages/cloudflare-conformance/generated/wrangler-help.json" with {
	type: "json",
};

export interface CommandParameter {
	choices?: string;
	defaultValue?: string;
	description: string;
	names: string[];
	required: boolean;
	scope: "global" | "local" | "positional";
	type?: string;
}

export interface CommandDefinition {
	children: string[];
	description?: string;
	help: string;
	invocation: string;
	options: CommandParameter[];
	path: string[];
	positionals: CommandParameter[];
}

interface RawHelpCommand {
	children: string[];
	description?: string;
	help: string;
	invocation: string;
	path: string[];
}

function parseMetadata(details: string): {
	choices?: string;
	defaultValue?: string;
	description: string;
	required: boolean;
	type?: string;
} {
	const metadataStart = details.search(
		/\s{2}\[(?:array|boolean|choices:|count|default:|number|required|string)/,
	);
	const description = (
		metadataStart === -1 ? details : details.slice(0, metadataStart)
	).trim();
	const metadata = metadataStart === -1 ? "" : details.slice(metadataStart);
	const type = metadata.match(/\[(array|boolean|count|number|string)\]/)?.[1];
	const choices = metadata.match(/\[choices: (.*?)\](?:\s+\[|$)/)?.[1];
	const defaultValue = metadata.match(/\[default: (.*)\]\s*$/)?.[1];

	return {
		...(choices === undefined ? {} : { choices }),
		...(defaultValue === undefined ? {} : { defaultValue }),
		description,
		required: metadata.includes("[required]"),
		...(type === undefined ? {} : { type }),
	};
}

function parseParameterRow(
	line: string,
	scope: CommandParameter["scope"],
): CommandParameter | undefined {
	if (!line.startsWith("  ") || line.trimStart().startsWith("wrangler ")) {
		return undefined;
	}
	const content = line.trimStart();
	const separator = content.search(/\s{2,}/);
	if (separator === -1) {
		return undefined;
	}
	const names = content
		.slice(0, separator)
		.split(",")
		.map((name) => name.trim())
		.filter((name) => name.length > 0);
	if (
		names.length === 0 ||
		(scope === "positional"
			? names.some((name) => name.startsWith("-"))
			: names.some((name) => !name.startsWith("-")))
	) {
		return undefined;
	}

	return {
		...parseMetadata(content.slice(separator).trim()),
		names,
		scope,
	};
}

function parseParameters(help: string): {
	options: CommandParameter[];
	positionals: CommandParameter[];
} {
	const options: CommandParameter[] = [];
	const positionals: CommandParameter[] = [];
	let scope: CommandParameter["scope"] | undefined;

	for (const line of help.split("\n")) {
		if (line === "POSITIONALS") {
			scope = "positional";
			continue;
		}
		if (line === "OPTIONS") {
			scope = "local";
			continue;
		}
		if (line === "GLOBAL FLAGS") {
			scope = "global";
			continue;
		}
		if (/^[A-Z][A-Z &]+$/.test(line)) {
			scope = undefined;
			continue;
		}
		if (scope === undefined || line.length === 0) {
			continue;
		}

		const parameter = parseParameterRow(line, scope);
		if (parameter !== undefined) {
			if (scope === "positional") {
				positionals.push(parameter);
			} else {
				options.push(parameter);
			}
		}
	}
	return { options, positionals };
}

function createDefinition(command: RawHelpCommand): CommandDefinition {
	return {
		children: command.children,
		...(command.description === undefined
			? {}
			: { description: command.description }),
		help: command.help,
		invocation: command.invocation,
		...parseParameters(command.help),
		path: command.path,
	};
}

export const commands = helpInventory.commands.map(createDefinition);
export const commandRegistry = new Map(
	commands.map((command) => [command.path.join(" "), command]),
);
export const pinnedWranglerVersion = helpInventory.wranglerVersion;
