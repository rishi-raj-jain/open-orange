import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { check } from "./commands/check.js";
import { exampleResults, exampleResultsUsage } from "./commands/example-results.js";
import { generate } from "./commands/generate.js";
import { realProjects, realProjectsUsage } from "./commands/real-projects.js";
import { saveResults, saveResultsUsage } from "./commands/save-results.js";
import { truthTable, truthTableUsage } from "./commands/truth-table.js";
import { upstream, upstreamUsage } from "./commands/upstream.js";

const usage = `Usage: cloudflare-conformance <command>

Commands:
  generate      Regenerate the pinned Cloudflare reference artifacts
  check         Check OpenOrange against the generated reference artifacts
  upstream      Run the pinned upstream workerd test suite against orange dev
  save-results  Save a compact upstream run snapshot to results/
  real-projects Run real open-source projects through orange dev
  example-results Save the examples' outcomes for the truth table
  truth-table   Build compat/truth-table.json from recorded results

${upstreamUsage}

${saveResultsUsage}

${realProjectsUsage}

${exampleResultsUsage}

${truthTableUsage}`;

interface CliIo {
	log(message: string): void;
	error(message: string): void;
}

interface CliCommands {
	check(): Promise<void>;
	generate(): Promise<void>;
	upstream(args: readonly string[], io: CliIo): Promise<void>;
	saveResults(args: readonly string[], io: CliIo): Promise<void>;
	realProjects(args: readonly string[], io: CliIo): Promise<void>;
	exampleResults(io: CliIo): Promise<void>;
	truthTable(io: CliIo): Promise<void>;
}

const defaultIo: CliIo = {
	log: (message) => console.log(message),
	error: (message) => console.error(message),
};

const defaultCommands: CliCommands = {
	check,
	generate,
	upstream,
	saveResults,
	realProjects,
	exampleResults,
	truthTable,
};

const commandsWithArguments = new Set(["upstream", "save-results", "real-projects"]);

export async function run(
	args: readonly string[],
	io: CliIo = defaultIo,
	commands: CliCommands = defaultCommands,
): Promise<number> {
	const [command, ...rest] = args;

	if (command === undefined || command === "--help" || command === "-h") {
		io.log(usage);
		return 0;
	}

	if (rest.length > 0 && !commandsWithArguments.has(command)) {
		io.error(`Unexpected arguments for ${command}: ${rest.join(" ")}`);
		return 2;
	}

	try {
		switch (command) {
			case "generate":
				await commands.generate();
				return 0;
			case "check":
				await commands.check();
				return 0;
			case "upstream":
				await commands.upstream(rest, io);
				return 0;
			case "save-results":
				await commands.saveResults(rest, io);
				return 0;
			case "real-projects":
				await commands.realProjects(rest, io);
				return 0;
			case "example-results":
				await commands.exampleResults(io);
				return 0;
			case "truth-table":
				await commands.truthTable(io);
				return 0;
			default:
				io.error(`Unknown command: ${command}`);
				io.error(usage);
				return 2;
		}
	} catch (error: unknown) {
		io.error(error instanceof Error ? error.message : String(error));
		return 1;
	}
}

const invokedPath = process.argv[1];
if (
	invokedPath !== undefined &&
	resolve(invokedPath) === fileURLToPath(import.meta.url)
) {
	process.exitCode = await run(process.argv.slice(2));
}
