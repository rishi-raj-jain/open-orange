// Idle WebSocket memory through real `orange serve` against a standalone Engine.
// usage: node measure.mjs <scenario: objects|sockets> <label>
// Reads resident (RSS) and proportional (PSS) memory of the runner process tree, apart from the Engine's.
import { execFileSync, spawn } from "node:child_process";
import { appendFileSync, cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

const [scenario, label] = process.argv.slice(2);
const repo = process.env.ORANGE_ROOT ?? join(import.meta.dirname, "../../../..");
const require = createRequire(join(repo, "package.json"));
const WS = require("ws");
const fromRivetKit = createRequire(require.resolve("rivetkit"));
const { getEnginePath } = fromRivetKit("@rivetkit/engine-cli");
const out = join(import.meta.dirname, "results", `${scenario}-${label}.jsonl`);
mkdirSync(join(import.meta.dirname, "results"), { recursive: true });
writeFileSync(out, "");
const token = "memory-test";
const SETTLE_INTERVAL_MS = 15_000;
const SETTLE_MIN_MS = Number(process.env.SETTLE_MIN_MS ?? 75_000); // past two ping intervals
const SETTLE_MAX_MS = 360_000;
const SETTLE_BAND_KB = 3_000; // the last 4 reads, over 45 s, stay within this

const lifecycle = new Map();
const lifecycleTimes = new Map();
const transitions = {};
const now = () => new Date().toISOString().slice(11, 19);
const log = (...parts) => console.log(now(), ...parts);
const record = (entry) => appendFileSync(out, `${JSON.stringify({ at: new Date().toISOString(), ...entry })}\n`);

async function freePort() {
	const s = createServer();
	await new Promise((r) => s.listen(0, "127.0.0.1", r));
	const { port } = s.address();
	await new Promise((r) => s.close(r));
	return port;
}

function tree(pid) {
	const seen = [pid];
	for (let i = 0; i < seen.length; i++) {
		try {
			const kids = readFileSync(`/proc/${seen[i]}/task/${seen[i]}/children`, "utf8").trim();
			if (kids) seen.push(...kids.split(/\s+/).map(Number));
		} catch {}
	}
	return seen;
}

function memoryOf(pids) {
	let rssKb = 0, pssKb = 0, procs = 0;
	for (const pid of pids) {
		try {
			const s = readFileSync(`/proc/${pid}/smaps_rollup`, "utf8");
			rssKb += Number(/^Rss:\s+(\d+)/m.exec(s)?.[1] ?? 0);
			pssKb += Number(/^Pss:\s+(\d+)/m.exec(s)?.[1] ?? 0);
			procs++;
		} catch {}
	}
	return { rssKb, pssKb, procs };
}

// Everything else on the box, so a noisy read is visible in the data.
function boxState() {
	const [l1] = readFileSync("/proc/loadavg", "utf8").split(" ");
	const others = execFileSync("ps", ["-eo", "pcpu=,cmd="], { encoding: "utf8" }).split("\n")
		.map((l) => l.trim()).filter((l) => /isolated-env|cargo|rustc|pnpm/.test(l) && !/grep|bash -c/.test(l)).length;
	const busy = execFileSync("ps", ["-eo", "stat=,cmd="], { encoding: "utf8" }).split("\n").filter((l) => /^R/.test(l.trim()) && !/ps -eo|oo-do3\/dist|rivet-engine|measure\.mjs/.test(l)).length;
	return { load1: Number(l1), otherSuiteProcs: others, otherRunnable: busy };
}

const engineDir = mkdtempSync(join(tmpdir(), "oo-mem-engine-"));
const projectDir = mkdtempSync(join(tmpdir(), "oo-mem-project-"));
cpSync(join(import.meta.dirname, "worker"), projectDir, { recursive: true });
const [guardPort, peerPort, metricsPort, servePort] = [await freePort(), await freePort(), await freePort(), await freePort()];
mkdirSync(join(engineDir, "log"));
writeFileSync(join(engineDir, "config.json"), JSON.stringify({ topology: { datacenter_label: 1, datacenters: { default: { datacenter_label: 1, is_leader: true, peer_url: `http://127.0.0.1:${peerPort}/`, public_url: `http://127.0.0.1:${guardPort}/` } } } }));
// The same settings as tests/orange-serve.test.ts.
const engine = spawn(getEnginePath(), ["--config", join(engineDir, "config.json")], {
	cwd: engineDir,
	env: { ...process.env, RIVET__API_PEER__HOST: "127.0.0.1", RIVET__API_PEER__PORT: String(peerPort), RIVET__AUTH__ADMIN_TOKEN: token, RIVET__GUARD__HOST: "127.0.0.1", RIVET__GUARD__PORT: String(guardPort), RIVET__METRICS__HOST: "127.0.0.1", RIVET__METRICS__PORT: String(metricsPort), RIVET__PEGBOARD__NODE_LOST_THRESHOLD: "7000", RIVET__OBJECT_STORAGE__PRIMARY__FILE_SYSTEM__PATH: join(engineDir, "objects"), RIVET__STORAGE__AUTO_PROVISION_PARTITIONS: "1", RIVET__STORAGE__BALANCING__ENABLED: "false", RIVET__STORAGE__COLD_STORE__DISK_CACHE_BYTES: "0", RIVET__STORAGE__LOG_DIRECTORY: join(engineDir, "log"), RIVET__STORAGE__LOG_SHARD__MAX_DISK_BYTES: String(1024 ** 3) },
	stdio: "ignore",
});
const api = `http://127.0.0.1:${guardPort}`;
const headers = { authorization: `Bearer ${token}` };
let serve;
let exiting = false;
async function shutdown(code) {
	if (exiting) return;
	exiting = true;
	try { serve?.kill("SIGTERM"); } catch {}
	await delay(3000);
	try { serve?.kill("SIGKILL"); } catch {}
	try { engine.kill("SIGTERM"); } catch {}
	await delay(2000);
	try { engine.kill("SIGKILL"); } catch {}
	rmSync(engineDir, { force: true, recursive: true });
	rmSync(projectDir, { force: true, recursive: true });
	process.exit(code);
}
process.on("SIGINT", () => shutdown(130));
process.on("SIGTERM", () => shutdown(143));
try {
	for (let i = 0; ; i++) {
		const r = await fetch(`${api}/actors/names?namespace=default`, { headers }).catch(() => undefined);
		if (r?.status === 200) break;
		if (i > 240) throw new Error("the Engine never became ready");
		await delay(250);
	}
	log("engine ready");
	serve = spawn(process.execPath, [join(repo, "dist/bin.js"), "serve", "--config", join(projectDir, "wrangler.jsonc")], {
		cwd: projectDir,
		env: { ...process.env, CI: "1", NO_COLOR: "1", RIVET_LOG_LEVEL: "info", PORT: String(servePort), RIVET_ENDPOINT: `http://default:${token}@127.0.0.1:${guardPort}` },
		stdio: ["ignore", "pipe", "pipe"],
	});
	let serveOutput = "";
	// The v3 Engine API returns null for sleep_ts, so sleep is read from the runner's lifecycle log, per actor.
	let partial = "";
	const collect = (c) => {
		const text = c.toString();
		if (process.env.SAVE_RUNNER_LOG) appendFileSync(process.env.SAVE_RUNNER_LOG, text);
		serveOutput = (serveOutput + text).slice(-20000);
		const lines = (partial + text).split("\n");
		partial = lines.pop();
		for (const line of lines) {
			const m = /actor lifecycle transition.*actor_id=(\S+).*old=(\S+) new=(\S+)/.exec(line);
			if (m) { lifecycle.set(m[1], m[3]); transitions[m[3]] = (transitions[m[3]] ?? 0) + 1; }
			if (m && process.env.SAVE_RUNNER_LOG) lifecycleTimes.set(m[1], { state: m[3], at: new Date().toISOString() });
		}
	};
	serve.stdout.on("data", collect);
	serve.stderr.on("data", collect);
	globalThis.serveOutputTail = () => serveOutput;
	for (let i = 0; !serveOutput.includes("orange serve listening on"); i++) {
		if (serve.exitCode !== null) throw new Error(`orange serve exited: ${serveOutput}`);
		if (i > 600) throw new Error(`orange serve never listened: ${serveOutput}`);
		await delay(100);
	}
	const origin = `http://127.0.0.1:${servePort}`;
	log("serve listening", "tree", tree(serve.pid).length);

	const read = () => ({ runner: memoryOf(tree(serve.pid)), engine: memoryOf(tree(engine.pid)), box: boxState() });
	// Reads every 15 s, until the last 4 reads agree. Records the wait, and whether it settled at all.
	async function settledRead(point, extra = () => ({})) {
		const started = Date.now();
		const history = [];
		for (;;) {
			const r = read();
			history.push(r.runner.rssKb);
			const waitedMs = Date.now() - started;
			const last = history.slice(-4);
			const stable = last.length === 4 && Math.max(...last) - Math.min(...last) <= SETTLE_BAND_KB;
			if ((waitedMs >= SETTLE_MIN_MS && stable) || waitedMs >= SETTLE_MAX_MS) {
				const entry = { point, waitS: Math.round(waitedMs / 1000), settled: stable, reads: history.length, firstRssKb: history[0], ...r, ...extra() };
				record(entry);
				log(point, `wait=${entry.waitS}s settled=${stable}`, `runner rss=${Math.round(r.runner.rssKb / 1024)}MB pss=${Math.round(r.runner.pssKb / 1024)}MB procs=${r.runner.procs}`, `engine rss=${Math.round(r.engine.rssKb / 1024)}MB`, `load=${r.box.load1} suites=${r.box.otherSuiteProcs} runnable=${r.box.otherRunnable}`, JSON.stringify(extra()));
				return entry;
			}
			await delay(SETTLE_INTERVAL_MS);
		}
	}

	await settledRead("empty-runner");
	await fetch(origin).then((r) => r.text());
	await settledRead("after-one-plain-request");

	const socketStats = { closed: 0, closeCodes: {}, pings: 0 };
	const open = (room) => new Promise((resolve, reject) => {
		const s = new WS(`ws://127.0.0.1:${servePort}/socket?room=${room}`, { perMessageDeflate: false });
		s.on("ping", () => socketStats.pings++);
		s.once("open", () => resolve(s));
		s.once("error", reject);
		s.on("close", (code) => { socketStats.closed++; socketStats.closeCodes[code] = (socketStats.closeCodes[code] ?? 0) + 1; });
	});
	async function openMany(items, width) {
		const sockets = [];
		const failures = [];
		for (let i = 0; i < items.length; i += width) {
			const batch = await Promise.allSettled(items.slice(i, i + width).map(open));
			for (const b of batch) (b.status === "fulfilled" ? sockets.push(b.value) : failures.push(String(b.reason?.message ?? b.reason)));
		}
		return { sockets, failures };
	}
	const ask = (s) => new Promise((resolve, reject) => {
		const t = setTimeout(() => reject(new Error("no reply")), 20000);
		s.once("message", (d) => { clearTimeout(t); resolve(JSON.parse(String(d))); });
		s.send("x");
	});
	const stats = () => ({ open: socketStats.openNow?.() ?? null, closed: socketStats.closed, closeCodes: { ...socketStats.closeCodes }, pings: socketStats.pings });

	// Each actor's last lifecycle state in the runner's log.
	function actorStates() {
		let terminated = 0;
		for (const state of lifecycle.values()) if (state === "Terminated") terminated++;
		return { total: lifecycle.size, sleeping: terminated, awake: lifecycle.size - terminated, transitions: { ...transitions } };
	}

	if (scenario === "objects") {
		const steps = process.env.STEPS?.split(",").map(Number) ?? [100, 500, 1000];
		const sockets = [];
		const rooms = [];
		socketStats.openNow = () => sockets.filter((s) => s.readyState === 1).length;
		let openFailures = 0;
		for (const target of steps) {
			const add = Array.from({ length: target - rooms.length }, (_, i) => `r${rooms.length + i}`);
			const t0 = Date.now();
			const { sockets: opened, failures } = await openMany(add, 20);
			rooms.push(...add); sockets.push(...opened); openFailures += failures.length;
			log(`opened ${target} rooms in ${Math.round((Date.now() - t0) / 1000)}s failures=${failures.length}`, failures[0] ?? "");
			record({ point: `open-${target}`, openSeconds: Math.round((Date.now() - t0) / 1000), failures: failures.length, firstFailure: failures[0] });
			await settledRead(`awake-${target}-objects`, () => ({ ...stats(), openFailures }));
			const st = actorStates();
			record({ point: `actors-awake-${target}`, ...st });
			log("engine says", JSON.stringify(st));
		}
		if (process.env.EXTRA_HOLD_MS) {
			await delay(Number(process.env.EXTRA_HOLD_MS));
			await settledRead(`awake-${steps.at(-1)}-objects-long-hold`, () => ({ ...stats(), openFailures }));
		}
		// Still answering, from the same instance, after the reads. Sample only: it is traffic.
		const asked = await Promise.allSettled(sockets.slice(0, 20).map(ask));
		record({ point: "awake-sample-replies", ok: asked.filter((a) => a.status === "fulfilled").length, of: 20 });
		// A new boot ID proves the instance stopped. The runner's log drops lines in a burst, so its count is only a hint.
		const bootOf = (r) => fetch(`${origin}/x?room=${r}&kind=boot`).then((x) => x.json()).then((j) => j.boot);
		const bootsOfAll = async () => {
			const found = new Map();
			for (let i = 0; i < rooms.length; i += 20) {
				const batch = rooms.slice(i, i + 20);
				const values = await Promise.all(batch.map(bootOf));
				batch.forEach((r, j) => found.set(r, values[j]));
			}
			return found;
		};
		const boots = await bootsOfAll();
		record({ point: "boots-read-before-close", rooms: boots.size });
		log("sample replies", asked.filter((a) => a.status === "fulfilled").length, "/ 20");
		for (const s of sockets) s.close(1000, "done");
		const tClose = Date.now();
		log("closed all sockets");
		for (;;) {
			await delay(5000);
			const st = actorStates();
			if (st.sleeping >= st.total && st.total > 0) { log(`all slept after ${Math.round((Date.now() - tClose) / 1000)}s`, JSON.stringify(st)); record({ point: "all-slept", seconds: Math.round((Date.now() - tClose) / 1000), ...st }); break; }
			if (Date.now() - tClose > Number(process.env.SLEEP_LIMIT_MS ?? 300000)) {
				const stuck = [...lifecycle].filter(([, state]) => state !== "Terminated").map(([id, state]) => ({ id, state, at: lifecycleTimes.get(id)?.at }));
				log("NOT all slept", JSON.stringify(st), JSON.stringify(stuck.slice(0, 40)));
				record({ point: "not-all-slept", ...st, stuck });
				break;
			}
		}
		await settledRead("after-sleep-settled", () => ({ ...stats() }));
		await delay(Number(process.env.LATE_WAIT_MS ?? 300000));
		const late = await settledRead("after-sleep-plus-5min", () => ({ ...stats() }));
		const st2 = actorStates();
		record({ point: "actors-after-sleep", ...st2 });
		log("engine says", JSON.stringify(st2));
		// New boots prove the instances really went. This wakes the sample, so it comes last.
		// This wakes every object, so it comes after every memory read.
		const after = await bootsOfAll();
		const same = rooms.filter((r) => after.get(r) === boots.get(r));
		record({ point: "all-rooms-new-boot", changed: rooms.length - same.length, of: rooms.length, sameBoot: same });
		log("rooms with a new boot", rooms.length - same.length, "/", rooms.length, "same:", same.slice(0, 20).join(","), "late rss", late.runner.rssKb);
	} else if (scenario === "sockets") {
		const steps = process.env.STEPS?.split(",").map(Number) ?? [1, 100, 500, 1000];
		const sockets = [];
		socketStats.openNow = () => sockets.filter((s) => s.readyState === 1).length;
		let openFailures = 0;
		for (const target of steps) {
			const t0 = Date.now();
			const { sockets: opened, failures } = await openMany(Array.from({ length: target - sockets.length }, () => "one"), 20);
			sockets.push(...opened); openFailures += failures.length;
			log(`opened to ${target} in ${Math.round((Date.now() - t0) / 1000)}s failures=${failures.length}`, failures[0] ?? "");
			record({ point: `open-${target}`, failures: failures.length, firstFailure: failures[0] });
			await settledRead(`one-object-${target}-sockets`, () => ({ ...stats(), openFailures }));
		}
		if (process.env.EXTRA_HOLD_MS) {
			await delay(Number(process.env.EXTRA_HOLD_MS));
			await settledRead(`one-object-${steps.at(-1)}-sockets-long-hold`, () => ({ ...stats(), openFailures }));
		}
		const reply = await ask(sockets[0]);
		record({ point: "object-saw", ...reply });
		log("object saw", JSON.stringify(reply));
		for (const s of sockets) s.close(1000, "done");
		const tClose = Date.now();
		for (;;) {
			await delay(5000);
			const st = actorStates();
			if (st.sleeping >= st.total && st.total > 0) { log(`slept after ${Math.round((Date.now() - tClose) / 1000)}s`, JSON.stringify(st)); record({ point: "all-slept", seconds: Math.round((Date.now() - tClose) / 1000), ...st }); break; }
			if (Date.now() - tClose > 300000) { log("NOT slept", JSON.stringify(st)); record({ point: "not-all-slept", ...st }); break; }
		}
		await settledRead("after-sleep-settled", () => ({ ...stats() }));
	}
	log("MEASUREDONE");
	await shutdown(0);
} catch (error) {
	log("FAILED", error?.stack ?? error, error?.cause ?? "");
	log("serve alive", serve?.exitCode === null, "code", serve?.exitCode, serve?.signalCode, "engine alive", engine.exitCode === null);
	log("serve output tail", String(globalThis.serveOutputTail?.() ?? "").slice(-1500));
	record({ point: "failed", error: String(error?.message ?? error) });
	await shutdown(1);
}
