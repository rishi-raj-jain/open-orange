import assert from "node:assert/strict";
import { createServer } from "node:http";

import type { Scenario } from "../../src/real-projects/scenario.js";

const originPort = 38919;

interface Snapshot {
	overallStatus: string;
	productionCommit: string | null;
	components: { id: string; status: string }[];
	openIncidents: { component: string; startedAt: string }[];
	recentIncidents: { component: string; resolvedAt: string | null }[];
}

/** Stands in for kody.codes and kody.run: the surfaces that probes.ts reads. */
function startOrigin() {
	const state = { up: true };
	const server = createServer((request, response) => {
		const { pathname } = new URL(request.url ?? "/", "http://origin");
		const json = (status: number, body: unknown, headers: Record<string, string> = {}) => {
			response.writeHead(status, { "content-type": "application/json", ...headers });
			response.end(JSON.stringify(body));
		};
		if (!state.up) return json(500, { ok: false });
		if (pathname === "/health") return json(200, { ok: true, commitSha: "abc1234" });
		if (pathname === "/mcp") return json(401, {}, { "www-authenticate": 'Bearer realm="kody"' });
		if (pathname === "/__runtime/health") return json(200, { status: "ok" });
		if (pathname === "/health/components") {
			const components = ["app_db", "kv", "assets"].map((id) => ({ id, ok: true, latencyMs: 1 }));
			return json(200, { ok: true, components });
		}
		return json(404, {});
	});
	server.listen(originPort, "127.0.0.1");
	return { state, stop: () => server.close() };
}

const scenario: Scenario = async (t) => {
	const origin = startOrigin();
	const snapshot = () => t.json<Snapshot>("/status.json");
	// Probes run from the one-minute cron. The deadline allows for that cadence and nothing else.
	const until = async (what: string, passes: number, check: (value: Snapshot) => boolean) => {
		const deadline = Date.now() + (passes + 1) * 60_000;
		let last: Snapshot | undefined;
		while (Date.now() < deadline) {
			last = await snapshot();
			if (check(last)) return last;
			await t.delay(3_000);
		}
		throw new Error(`${what} did not happen within ${passes + 1} minutes: ${JSON.stringify(last)?.slice(0, 300)}`);
	};
	const appStatus = (value: Snapshot) => value.components.find((component) => component.id === "app")?.status;
	const appOpen = (value: Snapshot) => value.openIncidents.find((incident) => incident.component === "app");
	let startedAt = "";

	try {
		await t.step("the status page and its JSON read from the store", "do-state", async () => {
			assert.equal((await t.json("/health")).ok, true);
			const first = await snapshot();
			assert.equal(first.components.length, 7);
			assert.match(await t.text("/"), /App &amp; API|App & API/);
		});

		await t.step("the one-minute cron runs a probe pass into the object", "alarm", async () => {
			const seen = await until("a probe pass", 1, (value) => appStatus(value) === "operational");
			assert.equal(seen.productionCommit, "abc1234");
		});

		await t.step("three failing passes open an incident, and the page shows it", "alarm", async () => {
			origin.state.up = false;
			const seen = await until("an open incident", 3, (value) => appOpen(value) !== undefined);
			startedAt = appOpen(seen)!.startedAt;
			assert.equal(seen.overallStatus, "down");
			assert.equal(appStatus(seen), "down");
		});

		await t.step("the open incident survives the object's sleep", "sleep", async () => {
			await t.waitForSleep();
			const seen = await snapshot();
			assert.equal(appOpen(seen)?.startedAt, startedAt);
		});

		await t.step("the open incident survives a restart", "restart", async () => {
			await t.restart();
			const seen = await snapshot();
			assert.equal(appOpen(seen)?.startedAt, startedAt);
		});

		await t.step("after the restart, the cron runs again, and two good passes resolve the incident", "alarm", async () => {
			origin.state.up = true;
			const seen = await until("a resolved incident", 2, (value) => appOpen(value) === undefined);
			const resolved = seen.recentIncidents.find((incident) => incident.component === "app");
			assert.ok(resolved?.resolvedAt);
			assert.equal(appStatus(seen), "operational");
		});
	} finally {
		origin.stop();
	}

	t.needsSecrets("an operator alert email goes out through the Cloudflare Email API", "http", ["CLOUDFLARE_API_TOKEN"]);
};

export default scenario;
