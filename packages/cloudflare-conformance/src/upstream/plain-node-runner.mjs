// Calls upstream workerd test exports in a plain Node.js process, the way `workerd test` calls
// them. Usage: node plain-node-runner.mjs <request.json>. It appends one JSON line per test to the
// request's `out` file, so a test that exits the process keeps the earlier results.
import {
	appendFileSync,
	chmodSync,
	lstatSync,
	mkdirSync,
	readFileSync,
	rmSync,
} from "node:fs";
import { pathToFileURL } from "node:url";

const { main, env, tests, testTimeoutMs, out, resetDirectory } = JSON.parse(
	readFileSync(process.argv[2], "utf8"),
);

// Empties the scratch /tmp before each test. `rmSync` does not follow symlinks. A test can chmod the
// directory to 0o000, so only that one directory gets its mode back, never recursively.
function reset() {
	try {
		rmSync(resetDirectory, { recursive: true, force: true });
	} catch {
		const stats = lstatSync(resetDirectory);
		if (stats.isDirectory() && !stats.isSymbolicLink()) {
			chmodSync(resetDirectory, 0o700);
		}
		rmSync(resetDirectory, { recursive: true, force: true });
	}
	mkdirSync(resetDirectory);
}
// Tells the parent that the runner stopped after a hang, so the rest runs in a new process.
const restartExitCode = 75;
const report = (line) => appendFileSync(out, `${JSON.stringify(line)}\n`);
const describe = (error) =>
	String((error && (error.stack || error.message)) || error).slice(0, 1500);

// workerd logs an uncaught error and keeps running, so the runner does too.
process.on("uncaughtException", (error) => console.error("uncaught", error));
process.on("unhandledRejection", (error) =>
	console.error("unhandled rejection", error),
);

let module;
try {
	module = await import(pathToFileURL(main).href);
} catch (error) {
	// Plain Node.js has no cloudflare: modules, so such a test says nothing about Node.js.
	const notRun = /Received protocol 'cloudflare:'/.test(describe(error));
	for (const test of tests) {
		report({
			test,
			ok: notRun ? null : false,
			error: `import failed: ${describe(error)}`,
		});
	}
	process.exit(0);
}
const ctx = { waitUntil() {}, passThroughOnException() {} };
const timedOut = Symbol("timed out");
for (const test of tests) {
	const target = module[test];
	if (typeof target?.test !== "function") {
		report({ test, ok: false, error: "export has no test()" });
		continue;
	}
	if (resetDirectory !== null) reset();
	let timer;
	try {
		await Promise.race([
			target.test({ scheduledTime: Date.now(), cron: "" }, env, ctx),
			new Promise((_, reject) => {
				timer = setTimeout(() => reject(timedOut), testTimeoutMs);
			}),
		]);
		report({ test, ok: true });
	} catch (error) {
		if (error === timedOut) {
			// The hung test can still run and break later tests, so they run in a new process,
			// as orange dev restarts after a hang.
			report({ test, ok: false, error: `timed out after ${testTimeoutMs} ms` });
			process.exit(restartExitCode);
		}
		report({ test, ok: false, error: describe(error) });
	} finally {
		clearTimeout(timer);
	}
}
process.exit(0);
