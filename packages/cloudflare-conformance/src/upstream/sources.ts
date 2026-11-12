import { execFile } from "node:child_process";
import {
	copyFile,
	mkdir,
	readFile,
	readdir,
	rename,
	rm,
	stat,
} from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export interface UpstreamPin {
	repository: string;
	tag: string;
	commit: string;
	configSchema: string;
	testDirectories: string[];
	/** Package-relative directories of Orange-written `.wd-test` files that run next to the upstream ones. */
	localTestDirectories: string[];
	/** Upstream file id to the reason Orange does not support what it tests. Its tests still count, as failures. */
	notSupported: Record<string, string>;
	/**
	 * Upstream file id to the reason the file writes to `/tmp`. Orange runs it unmodified under the
	 * host safety net, and plain Node.js runs it with its `/tmp` paths rewritten to a scratch directory.
	 */
	tmpWriters: Record<string, string>;
	/** `<file id> > <test>` to the reason the runner does not run that test on Orange or plain Node.js. */
	notRunTests: Record<string, string>;
	/**
	 * `<file id> > <test>` to the reason the test depends on behavior that Cloudflare documents
	 * as not guaranteed. A failure keeps its own cause and still counts.
	 */
	unguaranteedTests: Record<string, string>;
	/**
	 * `<file id> > <test>` to the Cloudflare quota that the test only checks. Orange does not enforce
	 * Cloudflare's quotas by design, so these tests are cut from the score and listed in the report.
	 */
	cloudflareQuotaTests: Record<string, string>;
}

export interface UpstreamTestFile {
	/** Stable result id, for example `api-tests--actor-kv-test`. */
	id: string;
	path: string;
	relativePath: string;
}

export interface UpstreamSources {
	checkoutPath: string;
	/** Import root that resolves the `/workerd/workerd.capnp` import used by every `.wd-test`. */
	capnpImportPath: string;
	files: UpstreamTestFile[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readReasons(value: unknown): Record<string, string> | undefined {
	if (value === undefined) return {};
	if (!isRecord(value)) return undefined;
	const reasons: Record<string, string> = {};
	for (const [id, reason] of Object.entries(value)) {
		if (typeof reason !== "string") return undefined;
		reasons[id] = reason;
	}
	return reasons;
}

export async function readUpstreamPin(path: string): Promise<UpstreamPin> {
	const value: unknown = JSON.parse(await readFile(path, "utf8"));
	const notSupported = isRecord(value)
		? readReasons(value.notSupported)
		: undefined;
	const tmpWriters = isRecord(value)
		? readReasons(value.tmpWriters)
		: undefined;
	const notRunTests = isRecord(value)
		? readReasons(value.notRunTests)
		: undefined;
	const unguaranteedTests = isRecord(value)
		? readReasons(value.unguaranteedTests)
		: undefined;
	const cloudflareQuotaTests = isRecord(value)
		? readReasons(value.cloudflareQuotaTests ?? {})
		: undefined;
	if (
		isRecord(value) &&
		typeof value.repository === "string" &&
		typeof value.tag === "string" &&
		typeof value.commit === "string" &&
		/^[0-9a-f]{40}$/.test(value.commit) &&
		typeof value.configSchema === "string" &&
		Array.isArray(value.testDirectories) &&
		value.testDirectories.every((directory) => typeof directory === "string") &&
		(value.localTestDirectories === undefined ||
			(Array.isArray(value.localTestDirectories) &&
				value.localTestDirectories.every(
					(directory) => typeof directory === "string",
				))) &&
		notSupported !== undefined &&
		tmpWriters !== undefined &&
		notRunTests !== undefined &&
		unguaranteedTests !== undefined &&
		cloudflareQuotaTests !== undefined
	) {
		return {
			repository: value.repository,
			tag: value.tag,
			commit: value.commit,
			configSchema: value.configSchema,
			testDirectories: value.testDirectories,
			localTestDirectories: value.localTestDirectories ?? [],
			notSupported,
			tmpWriters,
			notRunTests,
			unguaranteedTests,
			cloudflareQuotaTests,
		};
	}
	throw new Error(
		`${path} must name a repository, tag, full commit SHA, configSchema, and testDirectories, localTestDirectories must list directories, and notSupported, tmpWriters, notRunTests, unguaranteedTests, and cloudflareQuotaTests must map ids to reasons`,
	);
}

async function exists(path: string): Promise<boolean> {
	try {
		await stat(path);
		return true;
	} catch {
		return false;
	}
}

async function git(cwd: string, args: string[]): Promise<string> {
	try {
		const { stdout } = await execFileAsync("git", args, {
			cwd,
			encoding: "utf8",
			maxBuffer: 16 * 1024 * 1024,
		});
		return stdout.trim();
	} catch (error: unknown) {
		const stderr =
			isRecord(error) && typeof error.stderr === "string"
				? error.stderr.trim()
				: "";
		throw new Error(
			`git ${args.join(" ")} failed${stderr === "" ? "" : `: ${stderr}`}`,
		);
	}
}

/** Sparse, shallow checkout of only the pinned test directories and config schema. */
async function fetchCheckout(
	pin: UpstreamPin,
	checkoutPath: string,
): Promise<void> {
	const staging = `${checkoutPath}.partial`;
	await rm(staging, { recursive: true, force: true });
	await mkdir(staging, { recursive: true });
	await git(staging, ["init", "--quiet"]);
	await git(staging, ["remote", "add", "origin", pin.repository]);
	await git(staging, [
		"sparse-checkout",
		"set",
		"--no-cone",
		...pin.testDirectories.map((directory) => `/${directory}/`),
		`/${pin.configSchema}`,
	]);
	await git(staging, [
		"fetch",
		"--quiet",
		"--depth",
		"1",
		"--filter=blob:none",
		"origin",
		pin.commit,
	]);
	await git(staging, ["checkout", "--quiet", "FETCH_HEAD"]);
	const head = await git(staging, ["rev-parse", "HEAD"]);
	if (head !== pin.commit) {
		throw new Error(
			`Fetched workerd ${head}, expected the pinned commit ${pin.commit}`,
		);
	}
	await rename(staging, checkoutPath);
}

async function listTestFiles(
	root: string,
	directory: string,
	idPrefix: string,
): Promise<UpstreamTestFile[]> {
	const names = (await readdir(join(root, directory)))
		.filter((name) => name.endsWith(".wd-test"))
		.sort();
	return names.map((name) => ({
		id: `${idPrefix}--${basename(name, ".wd-test")}`,
		path: join(root, directory, name),
		relativePath: `${directory}/${name}`,
	}));
}

export async function prepareUpstreamSources(
	pin: UpstreamPin,
	cacheDirectory: string,
	packageRoot: string,
): Promise<UpstreamSources> {
	const checkoutPath = join(cacheDirectory, `workerd-${pin.commit}`);
	if (!(await exists(checkoutPath))) {
		await mkdir(cacheDirectory, { recursive: true });
		await fetchCheckout(pin, checkoutPath);
	}

	const capnpImportPath = join(cacheDirectory, `capnp-import-${pin.commit}`);
	const schemaCopy = join(
		capnpImportPath,
		"workerd",
		basename(pin.configSchema),
	);
	if (!(await exists(schemaCopy))) {
		await mkdir(dirname(schemaCopy), { recursive: true });
		await copyFile(join(checkoutPath, pin.configSchema), schemaCopy);
	}

	const files: UpstreamTestFile[] = [];
	for (const directory of pin.testDirectories) {
		// Ids mirror the original harness (`api-tests`, `node-tests`) so runs stay comparable.
		const area = `${basename(dirname(directory))}-${basename(directory)}`;
		files.push(...(await listTestFiles(checkoutPath, directory, area)));
	}
	for (const directory of pin.localTestDirectories) {
		files.push(
			...(await listTestFiles(packageRoot, directory, basename(directory))),
		);
	}
	if (files.length === 0) {
		throw new Error(`No .wd-test files found in ${checkoutPath}`);
	}
	return { checkoutPath, capnpImportPath, files };
}
