import assert from "node:assert/strict";
import { type ChildProcess, spawn } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

import type { Scenario } from "../../src/real-projects/scenario.js";

// Browser Rendering through orange dev, with a real headless Chromium on the port that
// ORANGE_BROWSER_CDP_URL names. The same variables as the repository's browser test pick it:
// OPEN_ORANGE_TEST_CHROMIUM, or Playwright's headless shell, and OPEN_ORANGE_TEST_CHROMIUM_LIBS.
const port = 19222;

function chromiumPath(): string {
	const configured = process.env.OPEN_ORANGE_TEST_CHROMIUM;
	if (configured !== undefined && configured.length > 0) return configured;
	const cache = join(homedir(), ".cache", "ms-playwright");
	const entries = existsSync(cache) ? readdirSync(cache).filter((name) => name.startsWith("chromium_headless_shell-")).sort().reverse() : [];
	for (const entry of entries) {
		for (const candidate of ["chrome-linux/headless_shell", "chrome-headless-shell-linux64/chrome-headless-shell"]) {
			if (existsSync(join(cache, entry, candidate))) return join(cache, entry, candidate);
		}
	}
	throw new Error("This probe needs a headless Chromium: set OPEN_ORANGE_TEST_CHROMIUM");
}

async function startChromium(): Promise<() => Promise<void>> {
	const profile = await mkdtemp(join(tmpdir(), "oo-probe-chromium-"));
	const libraries = process.env.OPEN_ORANGE_TEST_CHROMIUM_LIBS;
	const child: ChildProcess = spawn(
		chromiumPath(),
		["--headless", "--no-sandbox", "--remote-debugging-address=127.0.0.1", `--remote-debugging-port=${port}`, `--user-data-dir=${profile}`, "about:blank"],
		{
			env: { ...process.env, ...(libraries === undefined ? {} : { LD_LIBRARY_PATH: [libraries, process.env.LD_LIBRARY_PATH].filter(Boolean).join(":") }) },
			stdio: "ignore",
		},
	);
	const stop = async () => {
		if (child.exitCode === null) {
			const exited = new Promise((resolve) => child.once("exit", resolve));
			child.kill("SIGKILL");
			await exited;
		}
		await rm(profile, { force: true, recursive: true });
	};
	for (let attempt = 0; attempt < 150 && child.exitCode === null; attempt++) {
		try {
			if ((await fetch(`http://127.0.0.1:${port}/json/version`)).ok) return stop;
		} catch {}
		await delay(200);
	}
	await stop();
	throw new Error(`Chromium did not answer on 127.0.0.1:${port}`);
}

interface Read {
	heading: string;
	title: string;
	pngSignature: string;
	sessions: number;
}

const scenario: Scenario = async (t) => {
	const stopChromium = await startChromium();
	try {
		await t.step("launch() opens a page in the configured browser, reads it, and takes a PNG screenshot", "binding", async () => {
			const read = await t.json<Read>("/read?name=first");
			assert.equal(read.heading, "first");
			assert.equal(read.title, "page first");
			assert.equal(read.pngSignature, "PNG");
		});

		await t.step("two requests at once each read their own page", "binding", async () => {
			const [left, right] = await Promise.all([t.json<Read>("/read?name=left"), t.json<Read>("/read?name=right")]);
			assert.equal(left.heading, "left");
			assert.equal(right.heading, "right");
		});

		await t.step("browser.close() ends the session, and the next launch still works", "binding", async () => {
			const first = await t.json<Read>("/read?name=again");
			assert.equal(first.sessions, 0);
			assert.equal((await t.json<Read>("/read?name=after")).heading, "after");
		});

		await t.step("connect() to a session that is in use is refused", "binding", async () => {
			const result = await t.json<{ joined: boolean; error?: string }>("/join-busy");
			assert.equal(result.joined, false);
		});
	} finally {
		await stopChromium();
	}
};

export default scenario;
