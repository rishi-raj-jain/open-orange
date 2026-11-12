import { runtimeSettings } from "../../internal/runtime-settings.js";

export const workerUrlSetting = "ORANGE_MIGRATE_WORKER_URL";

/** True while this Worker moves from Cloudflare. Read only on paths that are already slow. */
export function isMigratingFromCloudflare(): boolean {
	return (runtimeSettings()[workerUrlSetting] ?? "") !== "";
}
