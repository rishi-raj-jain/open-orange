import { existsSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { parseArgs } from "node:util";

import { saveRun } from "../results/save.js";
import { packageRoot } from "./generate.js";

export const resultsDirectory = join(packageRoot, "results");

export const saveResultsUsage = `Usage: cloudflare-conformance save-results <run-dir> [options]

Saves a compact snapshot of an upstream run to results/ and rebuilds latest.json and history.json.

Options:
  --label <text>          Short run name for charts, for example "Orange PR #2"
  --note <text>           One sentence about the run
  --orange-sha <sha>      Orange commit, when run.json does not record it
  --rivetkit <version>    RivetKit version, when run.json does not record it
  --unverified <fields>   Comma-separated fields that are not verified, for example orange.sha`;

interface SaveResultsIo {
	log(message: string): void;
}

export async function saveResults(
	args: readonly string[],
	io: SaveResultsIo,
): Promise<void> {
	const { values, positionals } = parseArgs({
		args: [...args],
		options: {
			label: { type: "string" },
			note: { type: "string" },
			"orange-sha": { type: "string" },
			rivetkit: { type: "string" },
			unverified: { type: "string" },
		},
		strict: true,
		allowPositionals: true,
	});
	const [runArgument, ...extra] = positionals;
	if (runArgument === undefined || extra.length > 0) {
		throw new Error(saveResultsUsage);
	}
	const runDirectory = resolve(runArgument);
	if (!existsSync(join(runDirectory, "run.json"))) {
		throw new Error(`${runDirectory} has no run.json`);
	}
	const { path, snapshot } = await saveRun({
		runDirectory,
		resultsDirectory,
		...(values.label === undefined ? {} : { label: values.label }),
		...(values.note === undefined ? {} : { note: values.note }),
		...(values["orange-sha"] === undefined
			? {}
			: { orangeSha: values["orange-sha"] }),
		...(values.rivetkit === undefined ? {} : { rivetkit: values.rivetkit }),
		...(values.unverified === undefined
			? {}
			: { unverified: values.unverified.split(",").filter(Boolean) }),
	});
	const { all, upstream } = snapshot.totals;
	io.log(
		`saved ${relative(packageRoot, path)}  upstream ${upstream.pass}/${upstream.total}  all ${all.pass}/${all.total}`,
	);
}
