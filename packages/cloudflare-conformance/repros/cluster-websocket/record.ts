import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const here = import.meta.dirname;
const log = (name: string) => readFileSync(join(here, "logs", `${name}.log`), "utf8");
const count = (text: string, pattern: RegExp) => text.match(new RegExp(pattern, "g"))?.length ?? 0;

const idle = log("idle-without-pings");
const wrangler = log("idle-wrangler-dev");
const messages = log("rollout-with-messages");
const pings = log("rollout-with-pings");
const gone = log("client-gone");
const rollouts = messages + pings;

const checks: Array<[name: string, passed: boolean]> = [
	["an idle socket on a pool URL, with no pings, closes at 125 s with 1006", /CLOSED acc-idle after 125s code=1006/.test(idle)],
	["wrangler dev keeps idle sockets open for 360 s with no pings", count(wrangler, /STILL OPEN \S+-idle2? after 360s pongs=0/) === 2],
	["with pings, idle sockets stay open until a rollout closes them at 695 s", count(pings, /idle after 695s code=1012/) === 2],
	[
		"a rollout closes sockets with 1012, and each client reconnects on the first try",
		count(rollouts, /CLOSED .* code=1012/) === 4 && count(rollouts, /RECONNECTED .* try 1 /) === 4,
	],
	["a socket can also close with 1011 when its object's generation ends", /CLOSED std-idle after 59s code=1011 .*generation ended/.test(idle)],
	["after a rollout the object is a new instance, and an accepted socket's storage is kept", /RECONNECTED acc-msg try 1 newBoot=true count=15/.test(messages)],
	[
		"a cut client gives the object webSocketClose 1006 within about 1 s, and the object sleeps",
		/KILLED lastClose after 0s .*"code":1006/.test(gone) && /KILLED object slept: true/.test(gone),
	],
	[
		"a client that stops answering pings is closed with 1006 at about 90 s, and the object sleeps",
		/SILENT client saw close 1006 after 90s/.test(gone) && /SILENT object slept: true/.test(gone),
	],
];

writeFileSync(
	join(here, "result.json"),
	`${JSON.stringify(
		{
			orange: "pool builds on a Rivet cluster, 2026-11-05",
			ranAt: "2026-11-05T06:18:57.000Z",
			steps: checks.map(([name, passed]) => ({ name, kind: "websocket", status: passed ? "pass" : "fail", seconds: 0 })),
		},
		null,
		"\t",
	)}\n`,
);
