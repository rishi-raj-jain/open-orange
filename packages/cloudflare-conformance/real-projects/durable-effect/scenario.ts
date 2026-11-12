import assert from "node:assert/strict";

import type { Scenario, ScenarioContext } from "../../src/real-projects/scenario.js";

// These checks follow the project's own scripts/test-local.mjs, which polls for 30 s for each alarm.
async function eventually(t: ScenarioContext, check: () => Promise<boolean>, description: string): Promise<void> {
	const deadline = Date.now() + 30_000;
	while (Date.now() < deadline) {
		if (await check()) return;
		await t.delay(200);
	}
	throw new Error(`Timed out: ${description}`);
}

const post = (body?: unknown): RequestInit => ({
	method: "POST",
	headers: { "content-type": "application/json" },
	...(body === undefined ? {} : { body: JSON.stringify(body) }),
});

const scenario: Scenario = async (t) => {
	await t.step("health, OpenAPI, validation, and missing routes answer as documented", "http", async () => {
		assert.equal((await t.json<{ status: string }>("/api/health/")).status, "ok");
		const openapi = await t.json<{ paths: Record<string, unknown> }>("/api/openapi.json");
		assert.ok(openapi.paths["/api/counter/status/{counterId}"]);
		await t.text("/api/billing/create", post({ userId: "invalid", amount: "not a number" }), 400);
		await t.text("/not-found", {}, 404);
		assert.deepEqual(await t.json("/api/billing/status/missing"), { invoice: null, receipt: null });
	});

	await t.step("a counter keeps its state per instance, and its alarm increments it", "alarm", async () => {
		await t.json("/api/counter/start/counter-a");
		assert.deepEqual(await t.json("/api/counter/status/counter-a"), { counter: { count: 0 } });
		assert.deepEqual(await t.json("/api/counter/status/counter-b"), { counter: null });
		await eventually(
			t,
			async () => (await t.json<{ counter: { count: number } | null }>("/api/counter/status/counter-a")).counter?.count! >= 1,
			"counter's automatic alarm",
		);
	});

	let manualInvoice = "";
	let finalized: unknown;
	await t.step("an invoice dispatches a receipt to its sibling task, and a manual finalize reads it back", "do-state", async () => {
		const { invoiceId } = await t.json<{ invoiceId: string }>("/api/billing/create", post({ userId: "manual", amount: 42 }));
		manualInvoice = invoiceId;
		const created = await t.json<{ invoice: { status: string }; receipt: { invoiceId: string; userId: string } }>(`/api/billing/status/${invoiceId}`);
		assert.equal(created.invoice.status, "created");
		assert.equal(created.receipt.invoiceId, invoiceId);
		assert.equal(created.receipt.userId, "manual");
		finalized = await t.json(`/api/billing/finalize/${invoiceId}`, post());
		const state = finalized as { invoice: { status: string; receiptSent: boolean } };
		assert.equal(state.invoice.status, "finalized");
		assert.equal(state.invoice.receiptSent, true);
	});

	await t.step("onboarding queues a welcome email on its sibling task, and can be completed", "do-state", async () => {
		await t.json("/api/onboarding/start", post({ userId: "manual", email: "manual@example.com" }));
		const started = await t.json<{ onboarding: { step: string }; welcomeEmail: { to: string } }>("/api/onboarding/status/manual");
		assert.equal(started.onboarding.step, "welcome_email_queued");
		assert.equal(started.welcomeEmail.to, "manual@example.com");
		const completed = await t.json<{ onboarding: { step: string; completedAt: unknown } }>("/api/onboarding/complete/manual", post());
		assert.equal(completed.onboarding.step, "completed");
		assert.equal(typeof completed.onboarding.completedAt, "number");
	});

	let automaticInvoice = "";
	await t.step("billing and onboarding alarms complete on their own, and a repeating counter purges itself", "alarm", async () => {
		await t.json("/api/onboarding/start", post({ userId: "automatic", email: "automatic@example.com" }));
		({ invoiceId: automaticInvoice } = await t.json<{ invoiceId: string }>("/api/billing/create", post({ userId: "automatic", amount: 100 })));
		await eventually(t, async () => {
			const state = await t.json<{ invoice: { status: string; receiptSent: boolean } | null }>(`/api/billing/status/${automaticInvoice}`);
			return state.invoice?.status === "finalized" && state.invoice.receiptSent === true;
		}, "billing's automatic alarm");
		await eventually(t, async () => {
			const state = await t.json<{ onboarding: { step: string } | null }>("/api/onboarding/status/automatic");
			return state.onboarding?.step === "completed";
		}, "onboarding's automatic alarm");
		await eventually(
			t,
			async () => (await t.json<{ counter: unknown }>("/api/counter/status/counter-a")).counter === null,
			"counter's automatic purge",
		);
		await t.delay(2_200);
		assert.deepEqual(await t.json("/api/counter/status/counter-a"), { counter: null });
	});

	await t.step("every task sleeps, and its state comes back when it wakes", "sleep", async () => {
		await t.waitForSleep();
		assert.deepEqual(await t.json(`/api/billing/status/${manualInvoice}`), finalized);
		assert.equal((await t.json<{ onboarding: { step: string } }>("/api/onboarding/status/automatic")).onboarding.step, "completed");
	});

	await t.step("state and the purge persist across a restart", "restart", async () => {
		await t.restart();
		assert.deepEqual(await t.json(`/api/billing/status/${manualInvoice}`), finalized);
		const persisted = await t.json<{ invoice: { status: string; receiptSent: boolean } }>(`/api/billing/status/${automaticInvoice}`);
		assert.equal(persisted.invoice.status, "finalized");
		assert.equal(persisted.invoice.receiptSent, true);
		assert.equal((await t.json<{ onboarding: { step: string } }>("/api/onboarding/status/automatic")).onboarding.step, "completed");
		assert.deepEqual(await t.json("/api/counter/status/counter-a"), { counter: null });
	});
};

export default scenario;
