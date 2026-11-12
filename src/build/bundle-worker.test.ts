import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";

import { bundleWorker } from "./bundle-worker.js";
import { runtimeModuleRewrites } from "./rewrite-module-imports.js";

const fixture = (name: string): string =>
	new URL(`./fixtures/${name}`, import.meta.url).pathname;

function isWorkerModule(
	value: unknown,
): value is {
	NamedEntrypoint: unknown;
	default: {
		fetch(
			request: Request,
			environment: Record<string, unknown>,
		): Response;
	};
} {
	if (typeof value !== "object" || value === null) {
		return false;
	}
	const defaultExport = Reflect.get(value, "default");
	return (
		"NamedEntrypoint" in value &&
		typeof defaultExport === "object" &&
		defaultExport !== null &&
		typeof Reflect.get(defaultExport, "fetch") === "function"
	);
}

test("bundles a controlled ESM Worker with all entrypoint exports", async () => {
	const directory = await mkdtemp(join(tmpdir(), "open-orange-bundle-"));
	const outputPath = join(directory, "worker.mjs");
	try {
		const bundle = await bundleWorker({
			entrypoint: fixture("basic-worker.ts"),
			outputPath,
		});
		assert.equal(bundle.outputPath, outputPath);
		assert.ok(bundle.bytes.byteLength > 0);

		const workerModule: unknown = await import(pathToFileURL(outputPath).href);
		assert.equal(isWorkerModule(workerModule), true);
		if (!isWorkerModule(workerModule)) {
			throw new Error("Bundled fixture did not preserve its exports");
		}
		assert.equal(
			await (
				await workerModule.default.fetch(
					new Request("https://example.com/bundled"),
					{},
				)
			).text(),
			"/bundled",
		);
	} finally {
		await rm(directory, { force: true, recursive: true });
	}
});

test("rejects unsupported Cloudflare modules and rewrites allowlisted ones", async () => {
	const directory = await mkdtemp(join(tmpdir(), "open-orange-bundle-"));
	try {
		await assert.rejects(
			bundleWorker({
				entrypoint: fixture("cloudflare-module-worker.ts"),
				outputPath: join(directory, "rejected.mjs"),
			}),
			/cloudflare:workers.*not implemented/,
		);

		const outputPath = join(directory, "rewritten.mjs");
		await bundleWorker({
			entrypoint: fixture("cloudflare-module-worker.ts"),
			moduleRewrites: {
				"cloudflare:workers": "@open-orange/runtime-node/modules",
			},
			outputPath,
		});
		assert.match(
			await readFile(outputPath, "utf8"),
			/from "@open-orange\/runtime-node\/modules"/,
		);
	} finally {
		await rm(directory, { force: true, recursive: true });
	}
});

test("loads the enabled cloudflare:workers runtime module externally", async () => {
	const directory = await mkdtemp(join(tmpdir(), "open-orange-bundle-"));
	const outputPath = join(directory, "worker.mjs");
	try {
		await bundleWorker({
			entrypoint: fixture("cloudflare-module-worker.ts"),
			moduleRewrites: runtimeModuleRewrites(),
			outputPath,
		});
		assert.match(
			await readFile(outputPath, "utf8"),
			/from "\/.*cloudflare-workers\/index\.ts"/,
		);
		const workerModule: unknown = await import(pathToFileURL(outputPath).href);
		assert.equal(typeof Reflect.get(Object(workerModule), "ObjectClass"), "function");
	} finally {
		await rm(directory, { force: true, recursive: true });
	}
});

test("resolves bare and node: built-ins to one module that keeps APIs Workers rely on", async () => {
	const directory = await mkdtemp(join(tmpdir(), "open-orange-bundle-"));
	const outputPath = join(directory, "worker.mjs");
	try {
		await bundleWorker({
			entrypoint: fixture("node-module-worker.ts"),
			moduleRewrites: runtimeModuleRewrites(),
			outputPath,
		});
		const workerModule = Object(await import(pathToFileURL(outputPath).href));
		assert.equal(Reflect.get(workerModule, "sameModule"), true);
		assert.equal(Reflect.get(workerModule, "keptHelper"), true);
	} finally {
		await rm(directory, { force: true, recursive: true });
	}
});

test("defers module errors that workerd raises lazily to the importing module", async () => {
	const directory = await mkdtemp(join(tmpdir(), "open-orange-bundle-"));
	const outputPath = join(directory, "worker.mjs");
	try {
		await bundleWorker({
			entrypoint: fixture("lazy-module-errors/worker.js"),
			outputPath,
		});
		const workerModule = Object(await import(pathToFileURL(outputPath).href));
		assert.equal(Reflect.get(workerModule, "loaded"), true);
		await assert.rejects(Reflect.apply(Reflect.get(workerModule, "importMissing"), undefined, []), {
			name: "Error",
			message: 'No such module "missing.js".\n  imported from "imports-missing.js"',
		});
		await assert.rejects(
			Reflect.apply(Reflect.get(workerModule, "importRequiresTopLevelAwait"), undefined, []),
			{
				name: "Error",
				message: "Top-level await in module is not permitted at this time.",
			},
		);
	} finally {
		await rm(directory, { force: true, recursive: true });
	}
});
