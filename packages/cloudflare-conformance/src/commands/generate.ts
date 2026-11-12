import { execFile } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import {
	type ApiInventory,
	writeApiInventory,
} from "../generators/api-inventory.js";
import {
	type WranglerHelpInventory,
	writeWranglerHelpInventory,
} from "../generators/wrangler-help.js";
import {
	type GlobalInventory,
	writeGlobalInventory,
} from "../generators/global-inventory.js";
import { runnerProtocolFixture } from "../fixtures.js";
import type { NormalizedValue } from "../runners/protocol.js";
import {
	readWorkerdMetadata,
	runWorkerdFixture,
} from "../runners/workerd.js";
import { writeGlobalTypeChecks } from "../generators/type-checks.js";

const execFileAsync = promisify(execFile);
export const packageRoot = fileURLToPath(new URL("../../", import.meta.url));
export const referenceConfigPath = join(
	packageRoot,
	"reference",
	"wrangler.jsonc",
);
export const generatedDirectory = join(packageRoot, "generated");
export const generatedArtifactNames = [
	"cloudflare-runtime.d.ts",
	"cloudflare-surface.json",
	"cloudflare-globals.json",
	"type-checks.ts",
	"wrangler-help.json",
] as const;

export const runtimeDeclarationsPath = join(
	generatedDirectory,
	"cloudflare-runtime.d.ts",
);
export const apiInventoryPath = join(
	generatedDirectory,
	"cloudflare-surface.json",
);
export const wranglerHelpPath = join(
	generatedDirectory,
	"wrangler-help.json",
);
export const globalInventoryPath = join(
	generatedDirectory,
	"cloudflare-globals.json",
);
export const typeChecksPath = join(generatedDirectory, "type-checks.ts");

export interface GeneratedArtifacts {
	apiInventory: ApiInventory;
	globalInventory: GlobalInventory;
	wranglerHelpInventory: WranglerHelpInventory;
}

function stringArray(value: NormalizedValue): string[] {
	if (!Array.isArray(value) || !value.every((item) => typeof item === "string")) {
		throw new Error("Pinned workerd returned an invalid global-name inventory");
	}
	return value;
}

function normalizeDeclarations(source: string): string {
	return `${source
		.replaceAll("\r\n", "\n")
		.split("\n")
		.map((line) => line.trimEnd())
		.join("\n")
		.trimEnd()}\n`;
}

export async function generateRuntimeDeclarations(
	outputPath: string,
): Promise<void> {
	const temporaryDirectory = await mkdtemp(
		join(tmpdir(), "open-orange-conformance-"),
	);
	const wranglerOutputPath = join(
		temporaryDirectory,
		"cloudflare-runtime.d.ts",
	);

	try {
		await execFileAsync(
			process.platform === "win32" ? "wrangler.cmd" : "wrangler",
			[
				"types",
				wranglerOutputPath,
				"--include-env=false",
				"--include-runtime=true",
				"--config",
				referenceConfigPath,
			],
			{
				cwd: packageRoot,
				env: {
					...process.env,
					CI: "1",
					LANG: "C",
					LC_ALL: "C",
					NO_COLOR: "1",
				},
				maxBuffer: 4 * 1024 * 1024,
			},
		);

		const declarations = normalizeDeclarations(
			await readFile(wranglerOutputPath, "utf8"),
		);
		await mkdir(dirname(outputPath), { recursive: true });
		await writeFile(outputPath, declarations, "utf8");
	} finally {
		await rm(temporaryDirectory, { recursive: true, force: true });
	}
}

export async function generateArtifacts(
	outputDirectory: string,
): Promise<GeneratedArtifacts> {
	const declarationsPath = join(outputDirectory, "cloudflare-runtime.d.ts");
	const inventoryPath = join(outputDirectory, "cloudflare-surface.json");
	const globalsPath = join(outputDirectory, "cloudflare-globals.json");
	const typeChecksPath = join(outputDirectory, "type-checks.ts");
	const helpPath = join(outputDirectory, "wrangler-help.json");

	await mkdir(outputDirectory, { recursive: true });
	await generateRuntimeDeclarations(declarationsPath);
	const apiInventory = await writeApiInventory(declarationsPath, inventoryPath);
	const globalOutcome = await runWorkerdFixture(
		runnerProtocolFixture.workerdConfigPath,
		"globals",
	);
	if (globalOutcome.type !== "value") {
		throw new Error("Pinned workerd global introspection returned an error");
	}
	const globalInventory = await writeGlobalInventory(
		globalsPath,
		apiInventory,
		stringArray(globalOutcome.value),
		readWorkerdMetadata(),
	);
	let support: unknown;
	try {
		support = JSON.parse(
			await readFile(join(packageRoot, "support.json"), "utf8"),
		);
	} catch {
		support = undefined;
	}
	await writeGlobalTypeChecks(typeChecksPath, support);
	const wranglerHelpInventory = await writeWranglerHelpInventory(
		helpPath,
		packageRoot,
		referenceConfigPath,
	);
	return { apiInventory, globalInventory, wranglerHelpInventory };
}

export async function generate(): Promise<void> {
	await generateArtifacts(generatedDirectory);
}
