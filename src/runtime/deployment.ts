import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";

import type { ResolvedWranglerConfiguration } from "../config/load-wrangler.js";

export interface DeploymentStorage {
	deploymentIdentity: string;
	rivetStoragePath: string;
}

type DeploymentConfiguration = Pick<
	ResolvedWranglerConfiguration,
	"environment" | "projectRoot" | "workerName"
>;

// Actor names derive from the identity, so it is stored once and then kept,
// even when the project moves.
const identityFile = "deployment-identity";

function deploymentDigest(projectRoot: string | undefined, config: DeploymentConfiguration): string {
	const hash = createHash("sha256").update("open-orange-deployment\0");
	if (projectRoot !== undefined) hash.update(projectRoot);
	return hash
		.update("\0")
		.update(config.workerName ?? "")
		.update("\0")
		.update(config.environment ?? "")
		.digest("hex");
}

function rivetRoot(config: DeploymentConfiguration): string {
	return join(config.projectRoot, ".open-orange", "rivetkit");
}

// Storage made before the key dropped the project path.
function legacyStorage(config: DeploymentConfiguration): DeploymentStorage {
	const deploymentIdentity = deploymentDigest(config.projectRoot, config);
	return {
		deploymentIdentity,
		rivetStoragePath: join(rivetRoot(config), deploymentIdentity.slice(0, 32)),
	};
}

async function engineRunsIn(storagePath: string): Promise<boolean> {
	try {
		const stamp: unknown = JSON.parse(
			await readFile(join(storagePath, ".rivetkit", "var", "engine", "runtime.json"), "utf8"),
		);
		const pid = typeof stamp === "object" && stamp !== null && "pid" in stamp ? stamp.pid : undefined;
		if (typeof pid !== "number") return false;
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
}

async function resolveOne(
	config: DeploymentConfiguration,
	upgraded: boolean,
): Promise<DeploymentStorage> {
	const rivetStoragePath = join(
		rivetRoot(config),
		deploymentDigest(undefined, config).slice(0, 32),
	);
	const identityPath = join(rivetStoragePath, identityFile);
	const stored = await readFile(identityPath, "utf8").catch(() => undefined);
	if (stored !== undefined && stored.trim().length > 0) {
		return { deploymentIdentity: stored.trim(), rivetStoragePath };
	}
	const legacy = legacyStorage(config);
	if (existsSync(legacy.rivetStoragePath) && !existsSync(rivetStoragePath)) {
		// An Engine still open on the old directory would lose files when it
		// moves, so this start keeps the old directory and a later start moves it.
		if (await engineRunsIn(legacy.rivetStoragePath)) return legacy;
		await rename(legacy.rivetStoragePath, rivetStoragePath);
	}
	const deploymentIdentity = upgraded
		? legacy.deploymentIdentity
		: deploymentDigest(undefined, config);
	await mkdir(rivetStoragePath, { recursive: true });
	await writeFile(identityPath, `${deploymentIdentity}\n`);
	return { deploymentIdentity, rivetStoragePath };
}

/** The storage directory that `orange dev` uses for this Worker, found without writing anything. */
export function localDeploymentStoragePath(config: DeploymentConfiguration): string {
	const current = join(rivetRoot(config), deploymentDigest(undefined, config).slice(0, 32));
	const legacy = legacyStorage(config).rivetStoragePath;
	return !existsSync(current) && existsSync(legacy) ? legacy : current;
}

// One deployment per project, Worker name, and environment. `orange dev` and
// `orange d1` commands share its Rivet storage, so local data written by one
// is visible to the other. The first configuration owns the session's
// storage, so its old storage decides whether every Worker of the session
// keeps its old identity.
export async function resolveDeploymentStorages(
	configs: readonly DeploymentConfiguration[],
): Promise<DeploymentStorage[]> {
	const primary = configs[0];
	if (primary === undefined) return [];
	const upgraded = existsSync(legacyStorage(primary).rivetStoragePath);
	const storages: DeploymentStorage[] = [];
	for (const config of configs) storages.push(await resolveOne(config, upgraded));
	return storages;
}

export async function resolveDeploymentStorage(
	config: DeploymentConfiguration,
): Promise<DeploymentStorage> {
	return await resolveOne(config, existsSync(legacyStorage(config).rivetStoragePath));
}
