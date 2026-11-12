import { join } from "node:path";

import type { GeneratedTypesFixture } from "./checks/generated-types.js";

const fixturesRoot = join(import.meta.dirname, "../fixtures/bindings");

export const generatedTypesFixtures: GeneratedTypesFixture[] = [
	{
		bindings: [
			{
				bindingName: "MISSING_SECRET",
				factoryName: "secrets_store_secret",
			},
			{
				bindingName: "PRESENT_SECRET",
				factoryName: "secrets_store_secret",
			},
		],
		configPath: join(fixturesRoot, "secrets-store/wrangler.jsonc"),
		id: "secrets-store",
	},
	{
		bindings: [
			{
				bindingName: "VERSION_METADATA",
				factoryName: "version_metadata",
			},
		],
		configPath: join(fixturesRoot, "version-metadata/wrangler.jsonc"),
		id: "version-metadata",
	},
];
