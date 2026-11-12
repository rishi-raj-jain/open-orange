export const loaded = true;

export function importMissing() {
	return import("./imports-missing.js");
}

export function importRequiresTopLevelAwait() {
	return import("./requires-top-level-await.cjs");
}
