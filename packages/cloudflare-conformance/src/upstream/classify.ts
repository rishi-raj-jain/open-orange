import type { UpstreamFileResult, UpstreamTestResult } from "./run-file.js";

/**
 * `remapped-pass` and `remapped-fail` are outcomes that saved runs from before Orange had a private
 * `/tmp` recorded for files that ran with `/tmp` rewritten to a scratch directory. They count as
 * neither pass nor fail. New runs never produce them.
 */
export type SummaryStatus =
	| "pass"
	| "fail"
	| "infra"
	| "quota"
	| "remapped-pass"
	| "remapped-fail";

/** One scored upstream test. Field names match the original harness `summary.json` rows. */
export interface SummaryRow {
	file: string;
	area: string;
	test: string;
	status: SummaryStatus;
	cause: string | null;
	why?: string;
	sub?: string;
	error: string;
	/** Outcome on plain Node.js with stock built-ins. Node.js compat tests only. */
	node?: "pass" | "fail";
	nodeError?: string;
	/** For a `quota` row: what Orange did, and the Cloudflare quota the test checks. */
	outcome?: "pass" | "fail";
	quota?: string;
}

export const INFRA_CAUSE = "test-infra";
/** A test that only checks a Cloudflare quota. Orange does not enforce those by design. */
export const CLOUDFLARE_QUOTA_CAUSE = "Cloudflare quota, not enforced by design";

/**
 * A Node.js compat test that fails on plain Node.js tests workerd-specific behavior, so it is not
 * scored. Infra-excluded and `/tmp`-remapped tests are not scored either.
 */
export function isScored(row: { status: SummaryStatus; node?: string }): boolean {
	return (row.status === "pass" || row.status === "fail") && row.node !== "fail";
}

export function isWorkerdOnly(row: { status: SummaryStatus; node?: string }): boolean {
	return row.status !== "infra" && row.status !== "quota" && row.node === "fail";
}

/** A test of a `/tmp`-remapped file in an older saved run that plain Node.js does not fail. */
export function isRemapped(row: { status: SummaryStatus; node?: string }): boolean {
	return (
		(row.status === "remapped-pass" || row.status === "remapped-fail") &&
		row.node !== "fail"
	);
}

/** The area of workerd's Node.js tests. Every other upstream area tests Cloudflare APIs. */
export const NODE_AREA = "Node.js compat";
export const NOT_SUPPORTED_CAUSE = "Not supported";
export const UNGUARANTEED_CAUSE = "Relies on behavior Cloudflare does not guarantee";

const AREAS: ReadonlyArray<readonly [string, RegExp]> = [
	[
		"Durable Objects",
		/^synthetic--|^api-tests--(actor|sql|sync-kv|delete-all|websocket-hibernation|.*alarm|durable-object|storage|hibernat|.*-do-|do-)/,
	],
	[
		"RPC + entrypoints",
		/^api-tests--(js-rpc|rpc|.*entrypoint|worker-loader|service|.*loopback|.*-rpc)/,
	],
	[
		"Streams",
		/^api-tests--(streams|.*stream|identity-transform|compression|.*pipe)/,
	],
	[
		"Fetch, HTTP, sockets",
		/^api-tests--(fetch|http|request|response|headers|form-data|abortable|eventsource|websocket|sockets|.*fetch|.*http|cf-)/,
	],
	["Crypto", /^api-tests--.*crypto/],
	["Web platform", /^api-tests--/],
	[NODE_AREA, /^node-tests--/],
];

export function areaOf(id: string): string {
	const area = AREAS.find(([, pattern]) => pattern.test(id));
	if (area === undefined) {
		throw new Error(`Upstream test file ${id} matches no area`);
	}
	return area[0];
}

type Cause = [cause: string, why: string, sub?: string];

function firstLine(text: string, length: number): string {
	return (text.split("\n")[0] ?? "").slice(0, length);
}

// Rule order matters: the first matching rule names the cause.
function classifyFailure(
	test: UpstreamTestResult,
	file: UpstreamFileResult,
): Cause {
	const error = test.error ?? "";
	const boot = file.boot?.detail ?? "";
	let match: RegExpMatchArray | null;
	if ((match = error.match(/^Not run: (.*)/))) {
		return ["Not run", match[1] ?? ""];
	}
	if (/must extend OpenOrange DurableObject/.test(error)) {
		return [
			"DO class must extend DurableObject",
			"Orange rejects plain-class DOs. CF accepts them.",
		];
	}
	if (/workerd:(unsafe|test)|gc is not defined/.test(error + boot)) {
		return [INFRA_CAUSE, "Needs a workerd test-only module or global."];
	}
	if (
		(match = (error + boot).match(
			/Cloudflare module import \\?"(cloudflare:[\w-]+)/,
		))
	) {
		return [
			`${match[1]} module missing`,
			"The import fails at bundle time, so the whole file fails.",
		];
	}
	if (
		(match = error.match(
			/requested module '([^']+)' does not provide an export named '(\w+)'/,
		))
	) {
		const module = match[1]?.includes("cloudflare-workers")
			? "cloudflare:workers"
			: match[1];
		return [
			module === "cloudflare:workers"
				? `cloudflare:workers has no ${match[2]}`
				: `${module} lacks workerd-only exports`,
			`Missing export ${match[2]}, so the whole file fails to load.`,
		];
	}
	if (
		/durable_objects.bindings must not be empty|migration references unconfigured/.test(
			error + boot,
		)
	) {
		return [
			"Config rejected",
			"Orange requires every DO class to have a binding.",
		];
	}
	if ((match = error.match(/Cloudflare global (\w+) is not implemented/))) {
		return ["Missing CF globals", `Throwing stub for ${match[1]}.`, match[1]];
	}
	if (/Unsupported Wrangler|supports only compatibility/.test(error)) {
		return ["Config rejected", firstLine(error, Infinity)];
	}
	if (/Build failed/.test(error) || /Build failed/.test(boot)) {
		return [
			"Bundling fails",
			(file.boot?.detail ?? error)
				.split("\n")
				.slice(1, 3)
				.join(" ")
				.slice(0, 160),
		];
	}
	const droppedBindings = file.dropped.filter((dropped) =>
		dropped.startsWith("binding"),
	);
	if (
		droppedBindings.length > 0 &&
		/undefined \(reading|is not a function|undefined is not/.test(error)
	) {
		const kinds = [
			...new Set(
				droppedBindings.map((dropped) => dropped.match(/\((\w+)\)/)?.[1]),
			),
		].join(", ");
		return [
			"Unsupported binding",
			`Test uses a binding Orange cannot configure (${kinds}).`,
			kinds,
		];
	}
	if (/EADDRINUSE/.test(error) && test.kind === "boot") {
		return [INFRA_CAUSE, "Port collision in the parallel harness."];
	}
	if (
		/^fs-|^fs_/.test(fileName(file.id)) &&
		/\/tmp|EEXIST|ENOENT|EACCES/.test(error)
	) {
		return [
			"fs is the host disk, not a virtual fs",
			"Orange uses the host disk, so paths and errors differ from workerd's virtual file system.",
		];
	}
	if (/not implemented|NotSupportedError/.test(error)) {
		return ["Not-implemented API", firstLine(error, 160)];
	}
	if (test.kind === "crash") {
		return ["One test crashes the whole runtime", error.slice(0, 200)];
	}
	if (test.kind === "hang") {
		return ["Hangs (60s timeout)", firstLine(error, 160)];
	}
	if (test.kind === "boot") {
		return [
			"File fails at load",
			error.split("\n").slice(0, 4).join(" ").slice(0, 200),
		];
	}
	return ["Behavior differs", firstLine(error, 160)];
}

/** The `file` value that summary rows use for a file id. */
export function fileName(id: string): string {
	return id.replace(/^\w+-tests--/, "");
}

export function summarizeResults(
	results: readonly UpstreamFileResult[],
	notSupported: Readonly<Record<string, string>> = {},
	unguaranteedTests: Readonly<Record<string, string>> = {},
	cloudflareQuotaTests: Readonly<Record<string, string>> = {},
): SummaryRow[] {
	const rows: SummaryRow[] = [];
	for (const file of results) {
		for (const [name, test] of Object.entries(file.tests)) {
			if (test.status === "other-service") {
				continue;
			}
			const compact = (text: string) =>
				text.split("\n").slice(0, 3).join(" | ").slice(0, 300);
			const error = compact(test.error ?? "");
			const base = {
				file: fileName(file.id),
				area: areaOf(file.id),
				test: name.replace(/^[\w-]+:/, ""),
				...(test.node === undefined ? {} : { node: test.node }),
				...(test.nodeError === undefined
					? {}
					: { nodeError: compact(test.nodeError) }),
			};
			const quota = cloudflareQuotaTests[`${file.id} > ${base.test}`];
			if (quota !== undefined) {
				rows.push({
					...base,
					status: "quota",
					cause: CLOUDFLARE_QUOTA_CAUSE,
					outcome: test.status === "pass" ? "pass" : "fail",
					quota,
					error: test.status === "pass" ? "" : error,
				});
				continue;
			}
			if (test.status === "pass") {
				rows.push({
					...base,
					status: "pass",
					cause: null,
					error,
				});
				continue;
			}
			const reason = notSupported[file.id];
			const unguaranteed = unguaranteedTests[`${file.id} > ${base.test}`];
			const [cause, why, sub]: Cause =
				reason !== undefined
					? [NOT_SUPPORTED_CAUSE, reason]
					: unguaranteed !== undefined
						? [UNGUARANTEED_CAUSE, unguaranteed]
						: classifyFailure(test, file);
			rows.push({
				...base,
				status: cause === INFRA_CAUSE ? "infra" : "fail",
				cause,
				why,
				...(sub === undefined ? {} : { sub }),
				error,
			});
		}
	}
	return rows;
}
