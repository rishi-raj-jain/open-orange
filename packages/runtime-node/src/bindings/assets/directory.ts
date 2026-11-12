import { createHash } from "node:crypto";
import { createReadStream, readFileSync } from "node:fs";
import { stat } from "node:fs/promises";
import { join } from "node:path";
import { Readable } from "node:stream";

import ignore from "ignore";
import mime from "mime";

import type { AssetEntry, AssetLookup } from "./handler.js";

// The metadata files are configuration, never assets.
// https://github.com/cloudflare/workers-sdk/blob/be87ff0382c53a294e948e49419d25d653c50e86/packages/workers-shared/utils/helpers.ts#L71-L93
const defaultIgnorePatterns = ["/.assetsignore", "/_redirects", "/_headers"];

function isMissingFileError(error: unknown): boolean {
	const code: unknown =
		typeof error === "object" && error !== null ? Reflect.get(error, "code") : undefined;
	return code === "ENOENT" || code === "ENOTDIR" || code === "ENAMETOOLONG";
}

function readAssetsIgnore(directory: string): string[] {
	try {
		return readFileSync(join(directory, ".assetsignore"), "utf8").split("\n");
	} catch (error: unknown) {
		if (isMissingFileError(error)) return [];
		throw error;
	}
}

// Text types name UTF-8 like Wrangler's asset manifest.
// https://github.com/cloudflare/workers-sdk/blob/be87ff0382c53a294e948e49419d25d653c50e86/packages/workers-shared/utils/helpers.ts#L20-L30
function contentType(path: string): string | null {
	const type = mime.getType(path);
	return type !== null && type.startsWith("text/") && !type.includes("charset")
		? `${type}; charset=utf-8`
		: type;
}

// Looks assets up in the directory on every request, so `orange dev` serves
// file changes without a restart. Wrangler dev builds the same view of the
// directory when it starts: every regular file not matched by `.assetsignore`,
// with an ETag that changes when the file's path or modification time changes.
// https://github.com/cloudflare/workers-sdk/blob/be87ff0382c53a294e948e49419d25d653c50e86/packages/miniflare/src/plugins/assets/index.ts#L390-L469
export function createAssetLookup(directory: string): AssetLookup {
	const ignored = ignore().add([...defaultIgnorePatterns, ...readAssetsIgnore(directory)]);
	return async (pathname) => {
		// An asset path is "/" followed by a relative file path.
		const segments = pathname.split("/").slice(1);
		if (
			!pathname.startsWith("/") ||
			segments.some((segment) => segment === "" || segment === "." || segment === "..")
		) {
			return null;
		}
		const relativePath = segments.join("/");
		if (ignored.ignores(relativePath)) return null;
		const path = join(directory, ...segments);
		let stats: Awaited<ReturnType<typeof stat>>;
		try {
			stats = await stat(path);
		} catch (error: unknown) {
			if (isMissingFileError(error)) return null;
			throw error;
		}
		if (!stats.isFile()) return null;
		const eTag = createHash("sha256")
			.update(path + stats.mtimeMs.toString())
			.digest("hex")
			.slice(0, 32);
		return { contentType: contentType(path), eTag, path } satisfies AssetEntry;
	};
}

export function readAsset(asset: AssetEntry): ReadableStream<Uint8Array> {
	const stream: ReadableStream<Uint8Array> = Readable.toWeb(createReadStream(asset.path));
	return stream;
}
