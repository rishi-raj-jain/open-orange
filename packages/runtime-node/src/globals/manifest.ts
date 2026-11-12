import globalInventory from "../../../cloudflare-conformance/generated/cloudflare-globals.json" with {
	type: "json",
};
import { globalImplementationStatuses } from "./implementations.js";

export type GlobalSupportStatus = "unimplemented" | "partial" | "implemented";

export interface GlobalManifestEntry {
	name: string;
	status: GlobalSupportStatus;
}

function statusForGlobal(name: string): GlobalSupportStatus {
	const status: unknown = Reflect.get(globalImplementationStatuses, name);
	return status === "partial" || status === "implemented"
		? status
		: "unimplemented";
}

export const globalManifest: GlobalManifestEntry[] = globalInventory.globals.map(
	(entry): GlobalManifestEntry => ({
		name: entry.name,
		status: statusForGlobal(entry.name),
	}),
);
