import { readFileSync } from "node:fs";
import { join } from "node:path";

import { run } from "./exec.js";
import type { ReleaseOpts } from "./main.js";

interface PackageManifest {
	name: string;
	version: string;
	dependencies?: Record<string, string>;
}

export function readManifest(repoRoot: string): PackageManifest {
	return JSON.parse(readFileSync(join(repoRoot, "package.json"), "utf8"));
}

/** Same dist-tag rules as rivet-dev/agents: `rc`, then `latest`, then the minor channel. */
export function distTag(opts: ReleaseOpts): string {
	if (opts.version.includes("-rc.")) return "rc";
	if (opts.version.includes("-")) return "next";
	return opts.latest ? "latest" : opts.minorVersionChannel;
}

function npmVersionExists(repoRoot: string, name: string, version: string): boolean {
	const result = run("npm", ["view", `${name}@${version}`, "version"], {
		cwd: repoRoot,
		allowFailure: true,
	});
	return result.exitCode === 0 && result.stdout.trim() === version;
}

export function publishNpm(opts: ReleaseOpts) {
	const manifest = readManifest(opts.repoRoot);
	if (manifest.version !== opts.version) {
		throw new Error(
			`package.json is at ${manifest.version}, not ${opts.version}. Run the setup-local phase first.`,
		);
	}

	for (const [name, range] of Object.entries(manifest.dependencies ?? {})) {
		if (/^0\.0\.0-/.test(range)) {
			console.warn(`⚠️ Publishing with preview dependency ${name}@${range}`);
		}
	}

	if (npmVersionExists(opts.repoRoot, manifest.name, opts.version)) {
		console.log(`${manifest.name}@${opts.version} already exists on npm. Skipping.`);
		return;
	}

	const tag = distTag(opts);
	console.log(`==> Publishing ${manifest.name}@${opts.version} with dist-tag ${tag}`);
	// npm, not pnpm: npm 11.5.1+ authenticates with GitHub's OIDC token (npm trusted
	// publishing) and falls back to NODE_AUTH_TOKEN. `prepack` builds dist/.
	run("npm", ["publish", "--access", "public", "--tag", tag], {
		cwd: opts.repoRoot,
		inherit: true,
	});
	console.log(`✅ Published ${manifest.name}@${opts.version}`);
}
