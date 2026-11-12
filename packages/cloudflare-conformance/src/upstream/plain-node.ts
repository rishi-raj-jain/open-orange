import { spawn } from "node:child_process";
import { createWriteStream } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

export interface PlainNodeOutcome {
	/** `not-run` means plain Node.js cannot load the test, because it imports a `cloudflare:` module. */
	status: "pass" | "fail" | "not-run";
	error?: string;
}

export interface RunOnPlainNodeOptions {
	/** Directory that holds a `package.json` and the test modules. */
	directory: string;
	/** Main module path, relative to `directory`. */
	main: string;
	/** Export names. The default export is `default`. */
	tests: readonly string[];
	env: Readonly<Record<string, unknown>>;
	nodeFlags: readonly string[];
	logPath: string;
	timeoutMs: number;
	/** Directory the runner empties and recreates before each test, like workerd's per-request /tmp. */
	resetDirectory?: string;
	/** Time one test may take. Default 30 s. */
	testTimeoutMs?: number;
}

const runnerPath = fileURLToPath(
	new URL("./plain-node-runner.mjs", import.meta.url),
);
const defaultTestTimeoutMs = 30_000;

function killGroup(pid: number | undefined): void {
	if (pid === undefined) return;
	try {
		process.kill(-pid, "SIGKILL");
	} catch {}
}

interface RunnerLine {
	test: string;
	ok: boolean | null;
	error?: string;
}

async function runOnce(
	options: RunOnPlainNodeOptions,
	tests: readonly string[],
	timeoutMs: number,
	log: NodeJS.WritableStream,
): Promise<{ lines: RunnerLine[]; exit: string }> {
	const requestPath = join(options.directory, "__plain-node-request.json");
	const outPath = join(options.directory, "__plain-node-results.jsonl");
	await writeFile(outPath, "");
	await writeFile(
		requestPath,
		JSON.stringify({
			main: join(options.directory, options.main),
			env: options.env,
			tests,
			testTimeoutMs: options.testTimeoutMs ?? defaultTestTimeoutMs,
			out: outPath,
			resetDirectory: options.resetDirectory ?? null,
		}),
	);
	// The plain process must not inherit the tsx loader or other NODE_OPTIONS of this runner.
	const { NODE_OPTIONS: _, ...env } = process.env;
	const exit = await new Promise<string>((resolve) => {
		const child = spawn(
			process.execPath,
			[...options.nodeFlags, runnerPath, requestPath],
			{
				cwd: options.directory,
				detached: true,
				env,
				stdio: ["ignore", "pipe", "pipe"],
			},
		);
		child.stdout.pipe(log, { end: false });
		child.stderr.pipe(log, { end: false });
		const timer = setTimeout(() => killGroup(child.pid), timeoutMs);
		child.once("error", (error) => {
			clearTimeout(timer);
			resolve(`error ${error.message}`);
		});
		child.once("close", (code, signal) => {
			clearTimeout(timer);
			// Tests can start child processes, so the whole process group goes.
			killGroup(child.pid);
			resolve(`exit=${code ?? signal}`);
		});
	});
	const lines = (await readFile(outPath, "utf8"))
		.split("\n")
		.filter((line) => line !== "")
		.map((line) => JSON.parse(line) as RunnerLine);
	return { lines, exit };
}

/**
 * Calls upstream test exports in a plain Node.js process with stock built-ins. A test that passes
 * there tests Node.js behavior. A test that fails there tests workerd-specific behavior. When a
 * test ends the process or hangs, it fails and the rest run in a new process.
 */
export async function runOnPlainNode(
	options: RunOnPlainNodeOptions,
): Promise<Record<string, PlainNodeOutcome>> {
	const deadline = Date.now() + options.timeoutMs;
	const log = createWriteStream(options.logPath);
	const outcomes: Record<string, PlainNodeOutcome> = {};
	let remaining = [...options.tests];
	try {
		while (remaining.length > 0 && Date.now() < deadline) {
			const { lines, exit } = await runOnce(
				options,
				remaining,
				deadline - Date.now(),
				log,
			);
			for (const { test, ok, error } of lines) {
				outcomes[test] =
					ok === true
						? { status: "pass" }
						: { status: ok === null ? "not-run" : "fail", error: error ?? "" };
			}
			remaining = remaining.filter((test) => outcomes[test] === undefined);
			// The runner exits with 75 after a test hangs. That test already has its outcome.
			const ended = exit === "exit=75" ? undefined : remaining.shift();
			if (ended !== undefined) {
				outcomes[ended] = {
					status: "fail",
					error: `plain Node.js exited while running this test (${exit})`,
				};
			}
		}
	} finally {
		await new Promise<void>((resolve) => log.end(resolve));
	}
	for (const test of remaining) {
		outcomes[test] = {
			status: "fail",
			error: `plain Node.js ran out of its ${Math.round(options.timeoutMs / 1000)}s budget before this test`,
		};
	}
	return outcomes;
}
