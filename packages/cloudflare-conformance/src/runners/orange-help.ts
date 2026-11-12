import { execFile } from "node:child_process";
import { join } from "node:path";
import { promisify } from "node:util";

import type { HelpRunner } from "../generators/wrangler-help.js";

const execFileAsync = promisify(execFile);

export function normalizeOrangeExecutable(output: string): string {
	return output.replace(/\b(?:open-)?orange\b/g, "wrangler");
}

export function createOrangeHelpRunner(repositoryRoot: string): HelpRunner {
	const entrypoint = join(repositoryRoot, "src", "bin.ts");
	return async (path) => {
		const { stdout } = await execFileAsync(
			process.platform === "win32" ? "tsx.cmd" : "tsx",
			[entrypoint, ...path, "--help"],
			{
				cwd: repositoryRoot,
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
		return normalizeOrangeExecutable(stdout);
	};
}
