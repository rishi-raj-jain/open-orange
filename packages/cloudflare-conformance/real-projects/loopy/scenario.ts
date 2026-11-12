import assert from "node:assert/strict";
import { createHash, createHmac } from "node:crypto";

import type { Scenario } from "../../src/real-projects/scenario.js";

const publishToken = "local-publish-token-for-the-corpus-run";
const sessionSecret = "local-session-secret-for-the-corpus-run";
const admin = { Authorization: `Bearer ${publishToken}`, "Content-Type": "application/json" };

function loopDocument(number: string, slug: string, related: string) {
	return {
		number,
		slug,
		title: `The ${slug} loop`,
		summary: `Summary of ${slug}.`,
		seoTitle: `${slug} | Loop Library`,
		description: `A complete record for ${slug}.`,
		categoryLabel: "AI agent workflow",
		author: "Example Contributor",
		published: "2026-06-21",
		modified: "2026-06-21",
		prompt: `Run the ${slug} task, verify it, and stop when the goal is met.`,
		verifyTitle: "The stated goal is met.",
		verifyDetail: "Run the same acceptance check after each change.",
		useWhen: "Use it to test the catalog.",
		why: "It has the fields a page needs.",
		note: "Verify related slugs before publishing.",
		category: "engineering",
		featured: false,
		steps: ["Record the state.", "Make one change.", "Check again."],
		keywords: ["example loop", "agent workflow", slug],
		related: [related],
	};
}

const sha256 = (text: string) => createHash("sha256").update(text).digest("hex");

/** The manifest and revisions that `npm run loops:export` writes, for a fresh catalog. */
function backup() {
	const loops = [loopDocument("001", "docs-sweep", "test-sweep"), loopDocument("002", "test-sweep", "docs-sweep")];
	const at = "2026-06-21T00:00:00.000Z";
	const revisions = loops.map((loop, index) => ({
		id: index + 1,
		slug: loop.slug,
		action: "published",
		status: "published",
		actor: "corpus",
		loop,
		createdAt: at,
	}));
	const lines = revisions.map((revision) => `${JSON.stringify({ type: "revision", revision })}\n`).join("");
	const manifest = {
		schemaVersion: 2,
		active: true,
		activatedAt: at,
		exportedAt: at,
		loops: loops.map((loop) => ({ ...loop, status: "published" })),
		revisionCount: revisions.length,
		maxRevisionId: revisions.length,
		revisionDigest: sha256(`${"0".repeat(64)}\n${lines}`),
	};
	return { manifest: { ...manifest, restoreId: sha256(JSON.stringify(manifest)) }, revisions };
}

/** The token that `/auth/callback/github` hands out after GitHub confirms the identity. */
function sessionToken(id: string, username: string): string {
	const encoded = Buffer.from(
		JSON.stringify({ v: 1, sub: `github:${id}`, provider: "github", username, name: username, exp: Math.floor(Date.now() / 1000) + 3600 }),
	).toString("base64url");
	return `${encoded}.${createHmac("sha256", sessionSecret).update(encoded).digest("base64url")}`;
}

const scenario: Scenario = async (t) => {
	const alice = sessionToken("1", "alice");
	const bob = sessionToken("2", "bob");
	const postAdmin = (path: string, body: unknown) =>
		t.json(path, { method: "POST", headers: admin, body: JSON.stringify(body) });
	const vote = (slug: string, token: string, value: number) =>
		t.json(`/api/loops/${slug}/vote`, { method: "POST", body: JSON.stringify({ value, sessionToken: token }) });
	const viewerVotes = async (token: string) =>
		(await t.json("/auth/session", { method: "POST", body: JSON.stringify({ sessionToken: token }) })).viewerVotes;

	await t.step("a fresh catalog is closed, and a restored backup opens it", "do-state", async () => {
		const closed = await t.json("/api/loops", undefined, 503);
		assert.equal(closed.code, "catalog_not_active");
		await t.json("/admin/loops/docs-sweep", { headers: { Authorization: "Bearer wrong" } }, 401);

		const { manifest, revisions } = backup();
		const started = await postAdmin("/admin/loops/restore/start", manifest);
		assert.equal(started.started, true);
		await postAdmin("/admin/loops/restore/chunk", { restoreId: manifest.restoreId, revisions });
		const finished = await postAdmin("/admin/loops/restore/finalize", { restoreId: manifest.restoreId });
		assert.deepEqual(finished, { restored: 2, revisions: 2, active: true });

		const listed = await t.json("/api/loops");
		assert.equal(listed.count, 2);
		assert.match(await t.text("/loops/docs-sweep"), /The docs-sweep loop/);
	});

	await t.step("publishing checks the revision, and the new text reaches the public routes", "do-state", async () => {
		const current = (await t.json("/admin/loops/docs-sweep", { headers: admin })).loop;
		assert.equal(current.revision, 1);
		const edited = { ...loopDocument("001", "docs-sweep", "test-sweep"), description: "An edited description." };
		const put = (expectedRevision: number, status: number) =>
			t.json(
				"/admin/loops/docs-sweep",
				{ method: "PUT", headers: admin, body: JSON.stringify({ loop: edited, expectedRevision }) },
				status,
			);
		const stale = await put(0, 409);
		assert.equal(stale.code, "revision_conflict");
		await put(current.revision, 200);
		assert.equal((await t.json("/api/loops/docs-sweep")).loop.description, "An edited description.");
		const history = await t.json("/admin/loops/docs-sweep/revisions", { headers: admin });
		assert.equal(history.revisions.length, 2);
	});

	await t.step("two signed-in readers vote, and an unpublished loop is refused", "do-state", async () => {
		await t.json(
			"/api/loops/docs-sweep/vote",
			{ method: "POST", body: JSON.stringify({ value: 1 }) },
			401,
		);
		await t.json(
			"/api/loops/no-such-loop/vote",
			{ method: "POST", body: JSON.stringify({ value: 1, sessionToken: alice }) },
			404,
		);
		await vote("docs-sweep", alice, 1);
		const counted = await vote("docs-sweep", bob, 1);
		assert.deepEqual(counted.counts, { upvotes: 2, downvotes: 0, score: 2 });
		const changed = await vote("docs-sweep", bob, -1);
		assert.deepEqual(changed.counts, { upvotes: 1, downvotes: 1, score: 0 });
		await vote("test-sweep", alice, 1);
		assert.deepEqual(await viewerVotes(alice), { "docs-sweep": 1, "test-sweep": 1 });
	});

	const assertKept = async () => {
		assert.equal((await t.json("/api/loops/docs-sweep")).loop.description, "An edited description.");
		const { votes } = await t.json("/api/votes");
		assert.deepEqual(votes["docs-sweep"], { upvotes: 1, downvotes: 1, score: 0 });
		assert.deepEqual(votes["test-sweep"], { upvotes: 1, downvotes: 0, score: 1 });
		assert.deepEqual(await viewerVotes(bob), { "docs-sweep": -1 });
	};

	await t.step("the catalog and the votes survive the objects' sleep", "sleep", async () => {
		await t.waitForSleep();
		await assertKept();
	});

	await t.step("the catalog and the votes survive a restart", "restart", async () => {
		await t.restart();
		await assertKept();
		const next = (await t.json("/admin/loops/docs-sweep", { headers: admin })).loop;
		assert.equal(next.revision, 3);
	});

	t.needsSecrets("a weekly signup passes Turnstile and FormGuard, and reaches here.now", "do-state", [
		"TURNSTILE_SECRET_KEY",
		"HERENOW_API_KEY",
	]);
	t.needsSecrets("a reader signs in with GitHub", "http", ["GITHUB_OAUTH_CLIENT_ID", "GITHUB_OAUTH_CLIENT_SECRET"]);
};

export default scenario;
