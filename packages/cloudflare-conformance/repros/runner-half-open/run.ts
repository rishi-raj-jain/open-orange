import { spawn } from "node:child_process";
import { cpSync, globSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import net from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

const repositoryRoot = join(import.meta.dirname, "../../../..");
const token = "halfopen-token";
const waitSeconds = 75;

interface Pair {
	client: net.Socket;
	upstream: net.Socket;
	silent: boolean;
}

function engineBinary(): string {
	const [path] = globSync("node_modules/.pnpm/@rivetkit+engine-cli-*/node_modules/@rivetkit/engine-cli-*/rivet-engine", {
		cwd: repositoryRoot,
	});
	if (path === undefined) throw new Error("No rivet-engine binary. Run pnpm install at the repository root.");
	return join(repositoryRoot, path);
}

/** Starts a runner behind the proxy, applies the fault, and says whether the runner came back. */
async function runFault(fault: "close" | "silence", ports: { guard: number; proxy: number; serve: number }): Promise<void> {
	const directory = mkdtempSync(join(tmpdir(), "oo-halfopen-"));
	mkdirSync(join(directory, "log"));
	const guardOrigin = `http://127.0.0.1:${ports.guard}`;
	writeFileSync(
		join(directory, "config.json"),
		JSON.stringify({
			topology: {
				datacenter_label: 1,
				datacenters: {
					default: {
						datacenter_label: 1,
						is_leader: true,
						public_url: `${guardOrigin}/`,
						peer_url: `http://127.0.0.1:${ports.guard + 1}/`,
					},
				},
			},
		}),
	);
	const engine = spawn(engineBinary(), ["--config", join(directory, "config.json")], {
		cwd: directory,
		stdio: "ignore",
		env: {
			...process.env,
			RIVET__AUTH__ADMIN_TOKEN: token,
			RIVET__GUARD__HOST: "127.0.0.1",
			RIVET__GUARD__PORT: String(ports.guard),
			RIVET__API_PEER__HOST: "127.0.0.1",
			RIVET__API_PEER__PORT: String(ports.guard + 1),
			RIVET__METRICS__HOST: "127.0.0.1",
			RIVET__METRICS__PORT: String(ports.guard + 10),
			RIVET__OBJECT_STORAGE__PRIMARY__FILE_SYSTEM__PATH: join(directory, "objects"),
			RIVET__STORAGE__AUTO_PROVISION_PARTITIONS: "1",
			RIVET__STORAGE__BALANCING__ENABLED: "false",
			RIVET__STORAGE__COLD_STORE__DISK_CACHE_BYTES: "0",
			RIVET__STORAGE__LOG_DIRECTORY: join(directory, "log"),
			RIVET__STORAGE__LOG_SHARD__MAX_DISK_BYTES: String(1 << 30),
		},
	});
	const pairs = new Set<Pair>();
	const proxy = net
		.createServer((client) => {
			const upstream = net.connect(ports.guard, "127.0.0.1");
			const pair: Pair = { client, upstream, silent: false };
			pairs.add(pair);
			client.on("data", (data) => {
				if (!pair.silent) upstream.write(data);
			});
			upstream.on("data", (data) => {
				if (!pair.silent) client.write(data);
			});
			for (const socket of [client, upstream]) {
				socket.on("error", () => {});
				socket.on("close", () => {
					if (!pair.silent) {
						client.destroy();
						upstream.destroy();
					}
					pairs.delete(pair);
				});
			}
		})
		.listen(ports.proxy, "127.0.0.1");
	const headers = { Authorization: `Bearer ${token}` };
	const nodeCount = async (): Promise<number> => {
		try {
			const response = await fetch(`${guardOrigin}/pools/default/nodes?namespace=default&limit=5`, {
				headers,
				signal: AbortSignal.timeout(8_000),
			});
			return (((await response.json()) as { nodes?: unknown[] }).nodes ?? []).length;
		} catch {
			return 0;
		}
	};
	for (let attempt = 0; attempt < 60; attempt++) {
		const up = await fetch(`${guardOrigin}/actors/names?namespace=default`, {
			headers,
			signal: AbortSignal.timeout(3_000),
		}).catch(() => undefined);
		if (up?.ok === true) break;
		await delay(1_000);
	}
	const project = join(directory, "project");
	cpSync(join(repositoryRoot, "tests/fixtures/rpc-session-lifetime"), project, { recursive: true });
	const serve = spawn(process.execPath, [join(repositoryRoot, "dist/bin.js"), "serve", "--config", "wrangler.jsonc"], {
		cwd: project,
		stdio: "ignore",
		env: {
			...process.env,
			PORT: String(ports.serve),
			NODE_ENV: "production",
			RIVET_ENDPOINT: `http://127.0.0.1:${ports.proxy}`,
			RIVET_TOKEN: token,
			RIVET_NAMESPACE: "default",
			RIVET_POOL: "default",
		},
	});
	const callObject = async (): Promise<string> => {
		const started = Date.now();
		try {
			const response = await fetch(`http://127.0.0.1:${ports.serve}/boot`, { signal: AbortSignal.timeout(60_000) });
			return `${response.status} in ${Date.now() - started}ms`;
		} catch (error) {
			return `${(error as Error).name} in ${Date.now() - started}ms`;
		}
	};
	try {
		for (let attempt = 0; attempt < 40 && (await nodeCount()) === 0; attempt++) await delay(1_000);
		const before = await callObject();
		if (!before.startsWith("200 ")) throw new Error(`The object did not answer before the fault: ${before}`);
		for (const pair of pairs) {
			if (fault === "close") {
				pair.client.destroy();
				pair.upstream.destroy();
			} else {
				pair.silent = true;
			}
		}
		await delay(waitSeconds * 1_000);
		const nodes = await nodeCount();
		const after = await callObject();
		if (nodes === 0 || !after.startsWith("200 ")) {
			throw new Error(`${waitSeconds} s after the fault: ${nodes} nodes, object call ${after}`);
		}
	} finally {
		serve.kill("SIGKILL");
		engine.kill("SIGTERM");
		proxy.close();
		for (const pair of pairs) {
			pair.client.destroy();
			pair.upstream.destroy();
		}
		await delay(3_000);
		engine.kill("SIGKILL");
		rmSync(directory, { force: true, recursive: true });
	}
}

const steps = [];
for (const [name, fault, guard] of [
	["a runner reconnects after its Engine socket closes", "close", 26420],
	["a runner reconnects after its Engine socket stops carrying data", "silence", 26520],
] as const) {
	const started = Date.now();
	const seconds = () => Math.round((Date.now() - started) / 1_000);
	try {
		await runFault(fault, { guard, proxy: guard + 60, serve: guard + 70 });
		steps.push({ name, kind: "restart", status: "pass", seconds: seconds() });
	} catch (error) {
		steps.push({ name, kind: "restart", status: "fail", seconds: seconds(), error: (error as Error).message });
	}
	console.log(steps.at(-1));
}
const rivetkit = (
	JSON.parse(readFileSync(join(repositoryRoot, "packages/runtime-node/package.json"), "utf8")) as {
		dependencies: Record<string, string>;
	}
).dependencies.rivetkit;
writeFileSync(
	join(import.meta.dirname, "result.json"),
	`${JSON.stringify({ orange: process.env.ORANGE_SHA ?? "unknown", rivetkit, ranAt: new Date().toISOString(), steps }, null, "\t")}\n`,
);
process.exit(0);
