import type { GlobalInventory } from "../generators/global-inventory.js";

export interface RuntimeGlobalManifestEntry {
	name: string;
	status: string;
}

export function checkGlobalManifest(
	inventory: GlobalInventory,
	manifest: readonly RuntimeGlobalManifestEntry[],
	claimedStatuses: ReadonlyMap<string, string>,
): string[] {
	const errors: string[] = [];
	const expectedNames = inventory.globals.map((entry) => entry.name);
	const actualNames = manifest.map((entry) => entry.name);
	const duplicates = actualNames.filter(
		(name, index) => actualNames.indexOf(name) !== index,
	);
	if (duplicates.length > 0) {
		errors.push(`duplicate runtime global manifest names: ${[...new Set(duplicates)].join(", ")}`);
	}

	for (const name of expectedNames) {
		if (!actualNames.includes(name)) {
			errors.push(`missing runtime global manifest name: ${name}`);
		}
	}
	for (const name of actualNames) {
		if (!expectedNames.includes(name)) {
			errors.push(`extra runtime global manifest name: ${name}`);
		}
	}
	for (const entry of manifest) {
		if (!["unimplemented", "partial", "implemented"].includes(entry.status)) {
			errors.push(`invalid runtime global status for ${entry.name}: ${entry.status}`);
		}
		const expectedStatus = claimedStatuses.get(entry.name) ?? "unimplemented";
		if (entry.status !== expectedStatus) {
			errors.push(
				`runtime global status mismatch for ${entry.name}: expected ${expectedStatus}, received ${entry.status}`,
			);
		}
	}
	for (const name of claimedStatuses.keys()) {
		if (!expectedNames.includes(name)) {
			errors.push(`claimed global is absent from the runtime inventory: ${name}`);
		}
	}
	return errors;
}
