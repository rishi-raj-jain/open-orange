import assert from "node:assert/strict";
import { createHmac } from "node:crypto";

import type { Scenario } from "../../src/real-projects/scenario.js";

const ingestToken = "local-only-scenario-ingest-token";
const webhookSecret = "local-only-scenario-webhook-secret";

interface Ticket {
	state: string;
	leaseToken: string | null;
}

const scenario: Scenario = async (t) => {
	const signed = async <T>(path: string, payload: unknown, status = 200) => {
		const body = JSON.stringify(payload);
		const signature = `sha256=${createHmac("sha256", webhookSecret).update(body).digest("hex")}`;
		return await t.json<T>(
			path,
			{
				method: "POST",
				headers: { "content-type": "application/json", "x-clawsweeper-exact-review-signature": signature },
				body,
			},
			status,
		);
	};
	const acquire = async (ticketId: string, owner: string) =>
		(
			await signed<{ ticket: Ticket }>("/internal/state-writer/acquire", {
				ticket_id: ticketId,
				owner,
				branch: "state",
				repository: "openclaw/clawsweeper",
				workflow: "scenario",
				job: "scenario",
				run_id: ticketId,
				run_attempt: 1,
				writer_class: "ordinary",
			})
		).ticket;
	const postEvent = async (stage: string) =>
		(
			await t.json<{ event: { received_at: string } }>("/api/events", {
				method: "POST",
				headers: { authorization: `Bearer ${ingestToken}`, "content-type": "application/json" },
				body: JSON.stringify({ event_type: "status.test", mode: "e2e", stage, status: "ok" }),
			})
		).event.received_at;
	const recentEvents = async () => {
		const status = await t.json<{ recent: { events: unknown[] } }>("/api/status");
		return JSON.stringify(status.recent.events);
	};

	await t.step("answers its health route and an empty review queue", "http", async () => {
		assert.equal((await t.json<{ service: string }>("/api/health")).service, "clawsweeper-status");
		const queue = await t.json<{ collection: { state: string }; pending: number }>("/api/exact-review-queue");
		assert.equal(queue.collection.state, "complete");
		assert.equal(queue.pending, 0);
	});

	let receivedAt = "";

	await t.step("a workflow event needs the token, is stored in StatusStore, and shows on the status page", "do-state", async () => {
		await t.json("/api/events", { method: "POST", body: "{}" }, 401);
		receivedAt = await postEvent("probe");
		// The public projection keeps only the time, the work kind, and the duration of an event.
		assert.ok((await recentEvents()).includes(receivedAt), "the status page lists the event");
	});

	await t.step("a second state writer on a branch queues until the first releases", "do-state", async () => {
		await signed("/internal/state-writer/acquire", { ticket_id: "incomplete" }, 400);
		const first = await acquire("ticket-1", "writer-1");
		assert.equal(first.state, "leased");
		assert.equal((await acquire("ticket-2", "writer-2")).state, "queued");
		await signed("/internal/state-writer/release", {
			ticket_id: "ticket-1",
			owner: "writer-1",
			lease_token: first.leaseToken,
		});
		assert.equal((await acquire("ticket-2", "writer-2")).state, "leased");
	});

	await t.step("a cached GitHub response is stored in GithubEtagCache and found again", "do-state", async () => {
		const key = { credential_pool: "repository_actions", route: "/repos/openclaw/clawsweeper/pulls/1", surface: "apply" };
		const stored = await signed<{ stored: boolean }>(
			"/internal/exact-review/github-etag-cache/store",
			{ ...key, etag: 'W/"abc"', body: '{"name":"clawsweeper"}' },
			201,
		);
		assert.equal(stored.stored, true);
		const found = await signed<{ hit: boolean; entry: { etag: string } }>("/internal/exact-review/github-etag-cache/lookup", key);
		assert.equal(found.hit, true);
		assert.equal(found.entry.etag, 'W/"abc"');
	});

	await t.step("the objects sleep, and the lease holder and the queue keep their places", "sleep", async () => {
		await t.waitForSleep();
		assert.equal((await acquire("ticket-2", "writer-2")).state, "leased");
		assert.equal((await acquire("ticket-3", "writer-3")).state, "queued");
	});

	await t.step("the event and the lease survive an orange dev and engine restart", "restart", async () => {
		await t.restart();
		assert.ok((await recentEvents()).includes(receivedAt), "the status page lists the event");
		assert.equal((await acquire("ticket-2", "writer-2")).state, "leased");
	});

	t.needsSecrets("a review is enqueued, claimed by a worker, and completed in ExactReviewQueue", "do-state", [
		"GITHUB_TOKEN",
	]);
};

export default scenario;
