import { writeFile } from "node:fs/promises";

import type { ApiInventory } from "./api-inventory.js";
import type { WorkerdMetadata } from "../runners/workerd.js";

const valueDeclarationKinds = new Set([
	"class",
	"const",
	"enum",
	"function",
	"let",
	"namespace",
	"var",
]);

export interface GlobalInventoryEntry {
	declarations: {
		kind: string;
		signatureHashes: string[];
	}[];
	name: string;
}

export interface GlobalInventory {
	schemaVersion: 1;
	source: {
		apiInventorySha256: string;
		compatibilityDate: string;
		workerdVersion: string;
	};
	globals: GlobalInventoryEntry[];
}

export function createGlobalInventory(
	apiInventory: ApiInventory,
	runtimeGlobalNames: readonly string[],
	workerd: WorkerdMetadata,
): GlobalInventory {
	const runtimeNames = new Set(runtimeGlobalNames);
	const entries = new Map<string, GlobalInventoryEntry>();

	for (const declaration of apiInventory.declarations) {
		if (
			declaration.moduleSpecifier !== undefined ||
			(declaration.namespacePath?.length ?? 0) > 0 ||
			!valueDeclarationKinds.has(declaration.kind) ||
			!runtimeNames.has(declaration.name)
		) {
			continue;
		}
		let entry = entries.get(declaration.name);
		if (entry === undefined) {
			entry = { declarations: [], name: declaration.name };
			entries.set(declaration.name, entry);
		}
		entry.declarations.push({
			kind: declaration.kind,
			signatureHashes: declaration.signatureHashes,
		});
	}

	return {
		schemaVersion: 1,
		source: {
			apiInventorySha256: apiInventory.source.sha256,
			compatibilityDate: workerd.compatibilityDate,
			workerdVersion: workerd.version,
		},
		globals: [...entries.values()]
			.map((entry) => ({
				...entry,
				declarations: entry.declarations.sort((left, right) =>
					left.kind.localeCompare(right.kind),
				),
			}))
			.sort((left, right) => left.name.localeCompare(right.name)),
	};
}

export async function writeGlobalInventory(
	outputPath: string,
	apiInventory: ApiInventory,
	runtimeGlobalNames: readonly string[],
	workerd: WorkerdMetadata,
): Promise<GlobalInventory> {
	const inventory = createGlobalInventory(
		apiInventory,
		runtimeGlobalNames,
		workerd,
	);
	await writeFile(outputPath, `${JSON.stringify(inventory, null, "\t")}\n`, "utf8");
	return inventory;
}
