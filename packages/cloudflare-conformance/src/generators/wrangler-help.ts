import { execFile } from "node:child_process";
import { writeFile } from "node:fs/promises";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const concurrency = 4;

interface DiscoveredCommand {
	description?: string;
	path: string[];
}

export interface HelpCommand extends DiscoveredCommand {
	children: string[];
	help: string;
	invocation: string;
}

export interface WranglerHelpInventory {
	schemaVersion: 1;
	wranglerVersion: string;
	environment: {
		color: false;
		columns: 120;
		locale: "C";
	};
	commands: HelpCommand[];
}

export type HelpRunner = (path: readonly string[]) => Promise<string>;

const ansiSequence = /\u001B\[[0-?]*[ -/]*[@-~]/g;

export function normalizeHelp(output: string): string {
	return `${output
		.replace(ansiSequence, "")
		.replaceAll("\r\n", "\n")
		.split("\n")
		.map((line) => line.trimEnd())
		.join("\n")
		.trim()}\n`;
}

function commandKey(path: readonly string[]): string {
	return path.join(" ");
}

function pathFromUsage(usage: string): string[] | undefined {
	const tokens = usage.trim().split(/\s+/);
	if (tokens.shift() !== "wrangler") {
		return undefined;
	}

	const path: string[] = [];
	for (const token of tokens) {
		if (token.startsWith("[") || token.startsWith("<")) {
			break;
		}
		path.push(token);
	}
	return path;
}

function discoverChildren(
	help: string,
	parentPath: readonly string[],
): DiscoveredCommand[] {
	const children: DiscoveredCommand[] = [];
	for (const line of help.split("\n")) {
		if (
			line === "POSITIONALS" ||
			line === "OPTIONS" ||
			line === "GLOBAL FLAGS"
		) {
			break;
		}
		if (!line.startsWith("  wrangler")) {
			continue;
		}

		const content = line.slice(2);
		const separator = content.search(/\s{2,}/);
		if (separator === -1) {
			continue;
		}
		const usage = (separator === -1 ? content : content.slice(0, separator)).trim();
		const description = content.slice(separator).trim() || undefined;
		const path = pathFromUsage(usage);
		if (
			path === undefined ||
			description === undefined ||
			path.length !== parentPath.length + 1 ||
			!parentPath.every((segment, index) => path[index] === segment) ||
			!/^[a-z0-9][a-z0-9-]*$/.test(path.at(-1) ?? "")
		) {
			continue;
		}

		children.push({
			...(description === undefined ? {} : { description }),
			path,
		});
	}
	return children;
}

/**
 * Crawls the help tree from the root. `knownPaths` are crawled too, for a CLI whose own help lists
 * only some of the commands that answer `--help`, as Orange's root help does.
 */
export async function createWranglerHelpInventory(
	runHelp: HelpRunner,
	wranglerVersion: string,
	knownPaths: readonly (readonly string[])[] = [],
): Promise<WranglerHelpInventory> {
	const discovered = new Map<string, DiscoveredCommand>([["", { path: [] }]]);
	const pending: string[][] = [[]];
	for (const path of knownPaths) {
		const key = commandKey(path);
		if (discovered.has(key)) continue;
		discovered.set(key, { path: [...path] });
		pending.push([...path]);
	}
	const commands = new Map<string, HelpCommand>();

	while (pending.length > 0) {
		const batch = pending.splice(0, concurrency);
		const outputs = await Promise.all(batch.map((path) => runHelp(path)));

		for (const [index, path] of batch.entries()) {
			const key = commandKey(path);
			const help = normalizeHelp(outputs[index] ?? "");
			const children = discoverChildren(help, path);
			const metadata = discovered.get(key);
			if (metadata === undefined) {
				throw new Error(`Missing discovered command metadata for: ${key}`);
			}

			commands.set(key, {
				...metadata,
				children: children.map((child) => commandKey(child.path)),
				help,
				invocation: help.split("\n", 1)[0] ?? "",
			});

			for (const child of children) {
				const childKey = commandKey(child.path);
				if (!discovered.has(childKey)) {
					discovered.set(childKey, child);
					pending.push(child.path);
				}
			}
		}
	}

	return {
		schemaVersion: 1,
		wranglerVersion,
		environment: {
			color: false,
			columns: 120,
			locale: "C",
		},
		commands: [...commands.values()].sort((left, right) =>
			commandKey(left.path).localeCompare(commandKey(right.path)),
		),
	};
}

export function createPinnedWranglerHelpRunner(
	workingDirectory: string,
	configPath: string,
): HelpRunner {
	return async (path) => {
		const { stdout } = await execFileAsync(
			process.platform === "win32" ? "wrangler.cmd" : "wrangler",
			[...path, "--help", `--config=${configPath}`],
			{
				cwd: workingDirectory,
				env: {
					...process.env,
					CI: "1",
					COLUMNS: "120",
					FORCE_COLOR: "0",
					LANG: "C",
					LC_ALL: "C",
					LINES: "40",
					NO_COLOR: "1",
					TERM: "dumb",
				},
				encoding: "utf8",
				maxBuffer: 4 * 1024 * 1024,
			},
		);
		return stdout;
	};
}

export async function readPinnedWranglerVersion(
	workingDirectory: string,
): Promise<string> {
	const { stdout } = await execFileAsync(
		process.platform === "win32" ? "wrangler.cmd" : "wrangler",
		["--version"],
		{
			cwd: workingDirectory,
			env: { ...process.env, NO_COLOR: "1" },
			encoding: "utf8",
		},
	);
	return stdout.trim();
}

export async function writeWranglerHelpInventory(
	outputPath: string,
	workingDirectory: string,
	configPath: string,
): Promise<WranglerHelpInventory> {
	const inventory = await createWranglerHelpInventory(
		createPinnedWranglerHelpRunner(workingDirectory, configPath),
		await readPinnedWranglerVersion(workingDirectory),
	);
	await writeFile(outputPath, `${JSON.stringify(inventory, null, "\t")}\n`, "utf8");
	return inventory;
}
