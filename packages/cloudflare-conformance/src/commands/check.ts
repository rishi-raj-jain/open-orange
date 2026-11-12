import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { checkArtifactFreshness } from "../checks/artifact-freshness.js";
import { checkDurableObjectFixtures } from "../checks/durable-object-fixtures.js";
import { checkDurableObjectMatrix } from "../checks/durable-objects.js";
import {
	compareHelpInventories,
	replacedHelpCommands,
} from "../checks/help-parity.js";
import { checkGlobalManifest } from "../checks/globals.js";
import { checkGeneratedTypesFixtures } from "../checks/generated-types.js";
import { compileWorkerEventFixture } from "../checks/events.js";
import { checkSourceSafety } from "../checks/source-safety.js";
import {
	claimedGlobalStatuses,
	validateSupport,
} from "../checks/support.js";
import { compileConformanceTypeChecks } from "../checks/typescript.js";
import { createWranglerHelpInventory } from "../generators/wrangler-help.js";
import { differentialFixtures } from "../fixtures.js";
import { checkDifferentialFixtures } from "../runners/compare.js";
import { createOrangeHelpRunner } from "../runners/orange-help.js";
import { runOrangeFixture } from "../runners/orange.js";
import { runWorkerdFixture } from "../runners/workerd.js";
import { globalManifest } from "../../../runtime-node/src/globals/manifest.js";
import { fetchEventFixturePath } from "../event-fixtures.js";
import { generatedTypesFixtures } from "../generated-types-fixtures.js";
import {
	generateArtifacts,
	generatedArtifactNames,
	generatedDirectory,
	packageRoot,
} from "./generate.js";

const repositoryRoot = join(packageRoot, "../..");

export async function check(): Promise<void> {
	const temporaryDirectory = await mkdtemp(
		join(tmpdir(), "open-orange-conformance-check-"),
	);

	try {
		const generated = await generateArtifacts(temporaryDirectory);
		const errors = await checkArtifactFreshness(
			generatedDirectory,
			temporaryDirectory,
			generatedArtifactNames,
		);
		for (const diagnostic of await compileWorkerEventFixture(
			join(temporaryDirectory, "cloudflare-runtime.d.ts"),
			fetchEventFixturePath,
		)) {
			errors.push(
				`Worker fetch-event conformance failed (TS${diagnostic.code}): ${diagnostic.message}`,
			);
		}
		errors.push(
			...(await checkSourceSafety(
				[join(repositoryRoot, "src"), join(repositoryRoot, "packages/runtime-node/src")],
				repositoryRoot,
				// Cloudflare's Workflows engine, copied from workers-sdk. See its LICENSE file.
				["packages/runtime-node/src/bindings/workflows/engine"],
			)),
		);
		// Orange's root help lists only the commands that run in Orange, so the crawl also asks for
		// each command of Wrangler's tree.
		const orangeHelpInventory = await createWranglerHelpInventory(
			createOrangeHelpRunner(repositoryRoot),
			generated.wranglerHelpInventory.wranglerVersion,
			generated.wranglerHelpInventory.commands.map((command) => command.path),
		);
		errors.push(
			...compareHelpInventories(
				generated.wranglerHelpInventory,
				orangeHelpInventory,
				replacedHelpCommands,
			),
		);
		errors.push(
			...(await checkDifferentialFixtures(differentialFixtures, {
				orange: runOrangeFixture,
				workerd: runWorkerdFixture,
			})),
		);
		errors.push(
			...(await checkGeneratedTypesFixtures(
				generatedTypesFixtures,
				repositoryRoot,
			)),
		);

		let support: unknown;
		try {
			support = JSON.parse(
				await readFile(join(packageRoot, "support.json"), "utf8"),
			);
		} catch (error: unknown) {
			errors.push(
				`support.json is not valid JSON: ${
					error instanceof Error ? error.message : String(error)
				}`,
			);
		}

		if (support !== undefined) {
			errors.push(
				...validateSupport(
					support,
					generated.apiInventory,
					generated.wranglerHelpInventory,
				),
			);
			errors.push(
				...checkGlobalManifest(
					generated.globalInventory,
					globalManifest,
					claimedGlobalStatuses(support),
				),
			);
		}
		let durableObjectMatrix: unknown;
		try {
			durableObjectMatrix = JSON.parse(
				await readFile(join(packageRoot, "durable-objects.json"), "utf8"),
			);
		} catch (error: unknown) {
			errors.push(
				`durable-objects.json is not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
			);
		}
		if (durableObjectMatrix !== undefined) {
			errors.push(
				...checkDurableObjectMatrix(
					durableObjectMatrix,
					generated.apiInventory,
				),
			);
		}
		errors.push(
			...(await checkDurableObjectFixtures(
				packageRoot,
				join(temporaryDirectory, "cloudflare-runtime.d.ts"),
			)),
		);
		for (const diagnostic of await compileConformanceTypeChecks(
			join(temporaryDirectory, "type-checks.ts"),
			repositoryRoot,
		)) {
			errors.push(
				`generated type conformance failed (TS${diagnostic.code}): ${diagnostic.message}`,
			);
		}

		if (errors.length > 0) {
			throw new Error(
				`Cloudflare conformance check failed:\n${errors
					.map((error) => `- ${error}`)
					.join("\n")}\nRun \`pnpm --filter @open-orange/cloudflare-conformance generate\` to refresh generated artifacts.`,
			);
		}
	} finally {
		await rm(temporaryDirectory, { recursive: true, force: true });
	}
}
