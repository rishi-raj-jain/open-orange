import { readFile } from "node:fs/promises";
import { join } from "node:path";

function isMissingFile(error: unknown): boolean {
	return (
		typeof error === "object" &&
		error !== null &&
		"code" in error &&
		error.code === "ENOENT"
	);
}

async function readOptionalFile(path: string): Promise<Buffer | undefined> {
	try {
		return await readFile(path);
	} catch (error: unknown) {
		if (isMissingFile(error)) {
			return undefined;
		}
		throw error;
	}
}

export async function checkArtifactFreshness(
	trackedDirectory: string,
	freshDirectory: string,
	artifactNames: readonly string[],
): Promise<string[]> {
	const errors: string[] = [];
	for (const name of artifactNames) {
		const [tracked, fresh] = await Promise.all([
			readOptionalFile(join(trackedDirectory, name)),
			readOptionalFile(join(freshDirectory, name)),
		]);
		if (fresh === undefined) {
			errors.push(`generator did not produce generated/${name}`);
		} else if (tracked === undefined) {
			errors.push(`missing generated artifact: generated/${name}`);
		} else if (!tracked.equals(fresh)) {
			errors.push(`stale generated artifact: generated/${name}`);
		}
	}
	return errors;
}
