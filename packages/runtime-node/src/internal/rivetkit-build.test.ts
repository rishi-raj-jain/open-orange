import assert from "node:assert/strict";
import test from "node:test";

import {
	assertPinnedRivetKitBuild,
	discoverInstalledRivetKitBuild,
	PINNED_RIVETKIT_VERSION,
} from "./rivetkit-build.js";
import { createRivetRegistry } from "./rivetkit.js";

test("discovers one immutable RivetKit JS, native, and Engine build", () => {
	const build = discoverInstalledRivetKitBuild();
	assert.equal(build.packages.length, 5);
	assert.equal(new Set(build.packages.map(({ name }) => name)).size, 5);
	assert.ok(build.packages.every(({ version }) => version === PINNED_RIVETKIT_VERSION));
	assert.doesNotThrow(() => assertPinnedRivetKitBuild(build));
});

test("fails registry startup before setup when one package version differs", () => {
	const installedBuild = discoverInstalledRivetKitBuild();
	const packages = installedBuild.packages.map((packageManifest, index) =>
		index === 2
			? { ...packageManifest, version: "0.0.0-deliberate-mismatch" }
			: packageManifest,
	);
	assert.throws(
		() =>
			createRivetRegistry({
				engineHost: "127.0.0.1",
				enginePort: 6420,
				installedBuild: { ...installedBuild, packages },
				namespace: "default",
				use: {},
			}),
		/0\.0\.0-deliberate-mismatch/,
	);
});
