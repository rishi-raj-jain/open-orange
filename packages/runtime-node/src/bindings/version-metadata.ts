import { createHash } from "node:crypto";

export interface WorkerVersionMetadata {
	id: string;
	tag: string;
	timestamp: string;
}

export interface VersionMetadataInput {
	builtAt: Date;
	normalizedConfiguration: string;
	workerBundle: Uint8Array;
}

export function createWorkerVersionMetadata(
	input: VersionMetadataInput,
): WorkerVersionMetadata {
	const timestamp = input.builtAt.toISOString();
	const id = createHash("sha256")
		.update("open-orange-worker-version\0")
		.update(String(input.workerBundle.byteLength))
		.update("\0")
		.update(input.workerBundle)
		.update("\0")
		.update(input.normalizedConfiguration)
		.digest("hex");
	return { id, tag: "dev", timestamp };
}
