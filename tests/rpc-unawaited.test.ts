import assert from "node:assert/strict";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";

import { copyProject, repositoryRoot, startOrangeDev, type RunningOrangeDev } from "./orange-dev.js";

const slept = "old=SleepFinalize new=Terminated";

async function withDev(run: (dev: RunningOrangeDev) => Promise<void>): Promise<void> {
	const project = await copyProject(join(repositoryRoot, "tests", "fixtures", "rpc-unawaited"));
	try {
		const dev = await startOrangeDev(project.directory, "wrangler.jsonc", { actorLifecycleLogs: true });
		try {
			await run(dev);
		} finally {
			await dev.close();
		}
	} finally {
		await project.dispose();
	}
}

async function send(dev: RunningOrangeDev, route: string, key: string, log = "log"): Promise<void> {
	const response = await fetch(`${dev.origin}/${route}?key=${key}&log=${log}`);
	assert.equal(await response.text(), "sent");
}

async function read(dev: RunningOrangeDev, log = "log"): Promise<{ boot: string; keys: string[] }> {
	return (await (await fetch(`${dev.origin}/read?log=${log}`)).json()) as { boot: string; keys: string[] };
}

// Past the object's 500 ms delay, with a margin.
const pastTheCall = 2_000;

test("a Durable Object call that a Worker doesn't await runs after the Response, and its continuations don't", { timeout: 120_000 }, async () => {
	await withDev(async (dev) => {
		await send(dev, "bare", "bare");
		await send(dev, "observed", "observed");
		await send(dev, "failing", "failing");
		await send(dev, "chained", "chained");
		await delay(pastTheCall);
		assert.deepEqual((await read(dev)).keys, ["bare", "chained-first", "failing", "observed"]);
		assert.doesNotMatch(dev.output(), /continuation ran/);
	});
});

test("overlapping requests that don't await their Durable Object calls each deliver their own write", { timeout: 120_000 }, async () => {
	await withDev(async (dev) => {
		const keys = Array.from({ length: 20 }, (_, index) => `key-${String(index).padStart(2, "0")}`);
		const [awaited] = await Promise.all([read(dev), ...keys.map((key) => send(dev, "bare", key))]);
		assert.ok(awaited.boot.length > 0, "a request that awaits its call beside them got no answer");
		await delay(pastTheCall);
		assert.deepEqual((await read(dev)).keys, keys);
	});
});

test("an object sleeps after an unawaited call ends, even when the call returned a stub that nobody disposes", { timeout: 120_000 }, async () => {
	await withDev(async (dev) => {
		const before = await read(dev, "sleepy");
		const sleepsBefore = dev.output().split(slept).length;
		await send(dev, "session", "session", "sleepy");
		const deadline = Date.now() + 60_000;
		while (dev.output().split(slept).length <= sleepsBefore) {
			assert.ok(Date.now() < deadline, "the object did not sleep");
			await delay(250);
		}
		const after = await read(dev, "sleepy");
		assert.notEqual(after.boot, before.boot);
		assert.deepEqual(after.keys, ["session"]);
	});
});
