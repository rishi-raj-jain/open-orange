import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const here = import.meta.dirname;
const [header, ...lines] = readFileSync(join(here, "readings.csv"), "utf8").trim().split("\n");
const names = header!.split(",");
const rows = lines.map((line) => Object.fromEntries(line.split(",").map((value, index) => [names[index], value])));
const total = (run: string, point: string) => {
	const row = rows.find((candidate) => candidate.run === run && candidate.point === point);
	if (row === undefined) throw new Error(`No reading for ${run} ${point}`);
	return Number(row.runner_rss_mb) + Number(row.engine_rss_mb);
};
const baseline = (run: string) => total(run, "after-one-plain-request");
const objectRuns = ["objects-run1", "objects-run2", "objects-run3"];
const awakeCost = objectRuns.map((run) => (total(run, "awake-1000-objects") - baseline(run)) / 1000);
const keptCost = objectRuns.map((run) => (total(run, "after-sleep-plus-5min") - baseline(run)) / 1000);
const socketCost = (total("sockets-long1", "one-object-1000-sockets-long-hold") - baseline("sockets-long1")) / 1000;

const checks: Array<[name: string, passed: boolean]> = [
	["1,000 objects with one idle socket each cost about 1.1 MB per object", awakeCost.every((cost) => cost >= 1.05 && cost <= 1.2)],
	["1,000 idle sockets on one object cost about 0.2 MB per socket after a long hold", socketCost >= 0.18 && socketCost <= 0.23],
	["about half of an object's cost stays after it sleeps", keptCost.every((kept, index) => kept / awakeCost[index]! >= 0.35 && kept / awakeCost[index]! <= 0.65)],
];

writeFileSync(
	join(here, "result.json"),
	`${JSON.stringify(
		{
			orange: "96efb7b",
			ranAt: "2026-11-05T10:48:00.000Z",
			steps: checks.map(([name, passed]) => ({ name, kind: "websocket", status: passed ? "pass" : "fail", seconds: 0 })),
			measurements: { awakeMbPerObject: awakeCost, keptMbPerObject: keptCost, mbPerSocket: socketCost },
		},
		null,
		"\t",
	)}\n`,
);
