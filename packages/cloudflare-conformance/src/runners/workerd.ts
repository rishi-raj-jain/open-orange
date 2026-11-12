import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { createServer } from "node:net";
import { dirname } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

import { type FixtureOutcome, parseFixtureOutcome } from "./protocol.js";

const require = createRequire(import.meta.url);

export interface WorkerdMetadata {
	binaryPath: string;
	compatibilityDate: string;
	version: string;
}

export function readWorkerdMetadata(): WorkerdMetadata {
	const workerdModule: unknown = require("workerd");
	if (
		typeof workerdModule === "object" &&
		workerdModule !== null &&
		"default" in workerdModule &&
		typeof workerdModule.default === "string" &&
		"compatibilityDate" in workerdModule &&
		typeof workerdModule.compatibilityDate === "string" &&
		"version" in workerdModule &&
		typeof workerdModule.version === "string"
	) {
		return {
			binaryPath: workerdModule.default,
			compatibilityDate: workerdModule.compatibilityDate,
			version: workerdModule.version,
		};
	}
	throw new Error("The pinned workerd package did not expose its runtime metadata");
}

async function reserveLoopbackPort(): Promise<number> {
	const server = createServer();
	await new Promise<void>((resolve, reject) => {
		server.once("error", reject);
		server.listen(0, "127.0.0.1", resolve);
	});
	const address = server.address();
	await new Promise<void>((resolve, reject) => {
		server.close((error) => (error === undefined ? resolve() : reject(error)));
	});
	if (address === null || typeof address === "string") {
		throw new Error("Failed to reserve a loopback port for workerd");
	}
	return address.port;
}

async function fetchWhenReady(
	url: string,
	processState: { exitCode: number | null; error?: Error },
): Promise<FixtureOutcome> {
	const deadline = Date.now() + 10_000;
	while (Date.now() < deadline) {
		if (processState.error !== undefined) {
			throw processState.error;
		}
		if (processState.exitCode !== null) {
			throw new Error(`workerd exited before serving the fixture (${processState.exitCode})`);
		}
		try {
			const response = await fetch(url, { signal: AbortSignal.timeout(500) });
			if (!response.ok) {
				throw new Error(`workerd fixture returned HTTP ${response.status}`);
			}
			const outcome: unknown = await response.json();
			return parseFixtureOutcome(outcome);
		} catch (error: unknown) {
			if (error instanceof Error && error.message.startsWith("workerd fixture")) {
				throw error;
			}
			await delay(20);
		}
	}
	throw new Error("Timed out waiting for the workerd fixture server");
}

async function stopProcess(child: ReturnType<typeof spawn>): Promise<void> {
	if (child.exitCode !== null) {
		return;
	}
	const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()));
	child.kill("SIGTERM");
	await Promise.race([exited, delay(2_000)]);
	if (child.exitCode === null) {
		child.kill("SIGKILL");
		await exited;
	}
}

export async function runWorkerdFixture(
	configPath: string,
	testCase: string,
): Promise<FixtureOutcome> {
	const port = await reserveLoopbackPort();
	const child = spawn(
		readWorkerdMetadata().binaryPath,
		[
			"serve",
			configPath,
			`--socket-addr=http=127.0.0.1:${port}`,
		],
		{
			cwd: dirname(configPath),
			env: { ...process.env, NO_COLOR: "1" },
			stdio: ["ignore", "ignore", "pipe"],
		},
	);
	let stderr = "";
	let startupError: Error | undefined;
	child.stderr.setEncoding("utf8");
	child.stderr.on("data", (chunk: string) => {
		stderr = `${stderr}${chunk}`.slice(-8_192);
	});
	child.once("error", (error) => {
		startupError = error;
	});

	try {
		return await fetchWhenReady(
			`http://127.0.0.1:${port}/?case=${encodeURIComponent(testCase)}`,
			{
				get error() {
					return startupError;
				},
				get exitCode() {
					return child.exitCode;
				},
			},
		);
	} catch (error: unknown) {
		const detail = stderr.trim();
		throw new Error(
			`${error instanceof Error ? error.message : String(error)}${
				detail.length === 0 ? "" : `\nworkerd stderr:\n${detail}`
			}`,
		);
	} finally {
		await stopProcess(child);
	}
}
