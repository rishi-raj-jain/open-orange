import { readdir } from "node:fs/promises";
import { join, relative, sep } from "node:path";

export interface AdditionalModuleSearch {
	/** Wrangler's `base_dir`, or the entrypoint's directory. */
	root: string;
	/** The globs of every active module rule, in any module type. */
	globs: string[];
}

export interface AdditionalModule {
	/** The path below `/bundle`, relative to the search root and always with `/`. */
	name: string;
	path: string;
}

// As `glob-to-regexp` with `globstar`, which Wrangler uses: `*` stays within a path segment, and
// `**/` matches any number of segments, including none.
// https://github.com/cloudflare/workers-sdk/blob/be87ff0382c53a294e948e49419d25d653c50e86/packages/wrangler/src/deployment-bundle/find-additional-modules.ts
function moduleGlobRegExp(glob: string): RegExp {
	const pattern = glob
		.split(/(\*\*\/|\*\*|\*)/)
		.map((part) => {
			if (part === "**/") return "(?:[^/]*(?:/|$))*";
			if (part === "**") return ".*";
			if (part === "*") return "[^/]*";
			return part.replace(/[.+?^${}()|[\]\\/]/g, "\\$&");
		})
		.join("");
	return new RegExp(`^${pattern}$`);
}

// Local state directories, which Wrangler also leaves out for its own.
const skippedDirectories = new Set([".open-orange", ".wrangler"]);

async function* files(directory: string): AsyncGenerator<string> {
	for (const entry of await readdir(directory, { withFileTypes: true })) {
		const path = join(directory, entry.name);
		if (!entry.isDirectory()) yield path;
		else if (!skippedDirectories.has(entry.name)) yield* files(path);
	}
}

/**
 * The files that `find_additional_modules` adds to a Worker. Wrangler uploads them as modules, and
 * workerd shows each one read-only under `/bundle`.
 */
export async function findAdditionalModules(
	search: AdditionalModuleSearch,
	excluded: readonly string[],
): Promise<AdditionalModule[]> {
	const patterns = search.globs.map(moduleGlobRegExp);
	const modules: AdditionalModule[] = [];
	for await (const path of files(search.root)) {
		if (excluded.includes(path)) continue;
		const name = relative(search.root, path).split(sep).join("/");
		if (patterns.some((pattern) => pattern.test(name))) modules.push({ name, path });
	}
	return modules;
}
