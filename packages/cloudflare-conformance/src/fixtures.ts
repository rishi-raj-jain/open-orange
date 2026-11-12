import { join } from "node:path";

import {
	createSecretsStoreSecret,
	createWorkerVersionMetadata,
} from "@open-orange/runtime-node";

import type { DifferentialFixture } from "./runners/compare.js";

const runnerProtocolDirectory = join(
	import.meta.dirname,
	"../fixtures/runner-protocol",
);
const base64TextDirectory = join(
	import.meta.dirname,
	"../fixtures/globals/base64-text",
);
const navigatorDirectory = join(
	import.meta.dirname,
	"../fixtures/globals/navigator",
);
const globalScopeDirectory = join(
	import.meta.dirname,
	"../fixtures/globals/global-scope",
);
const messageEventDirectory = join(
	import.meta.dirname,
	"../fixtures/globals/message-event",
);
const httpDirectory = join(import.meta.dirname, "../fixtures/globals/http");
const webSocketDirectory = join(
	import.meta.dirname,
	"../fixtures/globals/websocket",
);
const versionMetadataDirectory = join(
	import.meta.dirname,
	"../fixtures/bindings/version-metadata",
);
const secretsStoreDirectory = join(
	import.meta.dirname,
	"../fixtures/bindings/secrets-store",
);

export const runnerProtocolFixture: DifferentialFixture = {
	cases: ["value", "error"],
	id: "runner-protocol",
	modulePath: join(runnerProtocolDirectory, "worker.ts"),
	workerdConfigPath: join(runnerProtocolDirectory, "workerd.capnp"),
};

export const base64TextFixture: DifferentialFixture = {
	cases: ["base64", "encoding"],
	id: "globals/base64-text",
	modulePath: join(base64TextDirectory, "worker.ts"),
	workerdConfigPath: join(base64TextDirectory, "workerd.capnp"),
};

export const navigatorFixture: DifferentialFixture = {
	cases: ["languages"],
	id: "globals/navigator",
	modulePath: join(navigatorDirectory, "worker.ts"),
	workerdConfigPath: join(navigatorDirectory, "workerd.capnp"),
};

export const globalScopeFixture: DifferentialFixture = {
	cases: ["worker-global-scope"],
	id: "globals/global-scope",
	modulePath: join(globalScopeDirectory, "worker.ts"),
	workerdConfigPath: join(globalScopeDirectory, "workerd.capnp"),
};

export const messageEventFixture: DifferentialFixture = {
	cases: ["init"],
	id: "globals/message-event",
	modulePath: join(messageEventDirectory, "worker.ts"),
	workerdConfigPath: join(messageEventDirectory, "workerd.capnp"),
};

export const httpFixture: DifferentialFixture = {
	cases: ["headers", "request", "response"],
	id: "globals/http",
	modulePath: join(httpDirectory, "worker.ts"),
	workerdConfigPath: join(httpDirectory, "workerd.capnp"),
};

export const webSocketFixture: DifferentialFixture = {
	cases: ["response", "frames", "validation", "close"],
	id: "globals/websocket",
	modulePath: join(webSocketDirectory, "worker.ts"),
	workerdConfigPath: join(webSocketDirectory, "workerd.capnp"),
};

export const versionMetadataFixture: DifferentialFixture = {
	cases: ["shape"],
	id: "bindings/version-metadata",
	modulePath: join(versionMetadataDirectory, "worker.ts"),
	orangeEnv: {
		VERSION_METADATA: createWorkerVersionMetadata({
			builtAt: new Date("2026-09-04T12:34:56.000Z"),
			normalizedConfiguration: '{"compatibility_date":"2026-09-03"}',
			workerBundle: new TextEncoder().encode("export default { fetch() {} }"),
		}),
	},
	workerdConfigPath: join(versionMetadataDirectory, "workerd.capnp"),
};

export const secretsStoreFixture: DifferentialFixture = {
	cases: ["present", "missing"],
	id: "bindings/secrets-store",
	modulePath: join(secretsStoreDirectory, "worker.ts"),
	orangeEnv: {
		MISSING_SECRET: createSecretsStoreSecret("MISSING_SECRET", {
			async resolve(): Promise<string | undefined> {
				return undefined;
			},
		}),
		PRESENT_SECRET: createSecretsStoreSecret("PRESENT_SECRET", {
			async resolve(): Promise<string> {
				return "fixture-secret-value";
			},
		}),
	},
	workerdConfigPath: join(secretsStoreDirectory, "workerd.capnp"),
};

export const differentialFixtures: DifferentialFixture[] = [
	runnerProtocolFixture,
	base64TextFixture,
	navigatorFixture,
	globalScopeFixture,
	messageEventFixture,
	httpFixture,
	webSocketFixture,
	versionMetadataFixture,
	secretsStoreFixture,
];
