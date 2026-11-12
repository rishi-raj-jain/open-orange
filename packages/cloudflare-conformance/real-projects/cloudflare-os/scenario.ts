import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { join } from "node:path";

import type { Scenario } from "../../src/real-projects/scenario.js";

interface Overseer {
	setTitle(title: string): Promise<void>;
	getMetadata(): Promise<{ id: string; title: string }>;
}
interface AuthenticatedApi {
	newWorkspace(): Promise<Overseer>;
	openWorkspace(id: string): Promise<Overseer>;
	whoami(): Promise<{ id: string; name: string }>;
	setOwnDisplayName(name: string): Promise<void>;
	isOnboardingCompleted(): Promise<boolean>;
	completeOnboarding(): Promise<void>;
	searchUsers(query: string, excludeIds: string[]): Promise<{ id: string; name: string }[]>;
}
interface PublicApi {
	ping(): Promise<void>;
	getServerConfig(): Promise<{ passwordAuthEnabled: boolean; signupsEnabled: boolean }>;
	createAccount(username: string, displayName: string, passwordHash: Uint8Array): Promise<string | null>;
	login(username: string, passwordHash: Uint8Array): Promise<string | null>;
	authenticate(token: string): Promise<AuthenticatedApi>;
}

const hashOf = (password: string) => new Uint8Array(createHash("sha256").update(password).digest());

// The session of packages/workshop-frontend/src/main.tsx: Cap'n Web over a WebSocket on /api.
const scenario: Scenario = async (t) => {
	const { newWebSocketRpcSession } = createRequire(join(t.directory, "package.json"))("capnweb") as {
		newWebSocketRpcSession(url: string): PublicApi & Disposable;
	};
	const session = async <T>(use: (api: PublicApi) => Promise<T>): Promise<T> => {
		const api = newWebSocketRpcSession(`${t.origin.replace(/^http/, "ws")}/api`);
		try {
			return await use(api);
		} finally {
			api[Symbol.dispose]();
		}
	};

	let token = "";
	let workspaceId = "";
	const titleOfWorkspace = async (user: AuthenticatedApi) =>
		(await (await user.openWorkspace(workspaceId)).getMetadata()).title;

	await t.step("the RPC endpoint refuses a plain GET and serves its config over a WebSocket", "http", async () => {
		await t.text("/api", undefined, 400);
		const config = await session((api) => api.getServerConfig());
		assert.equal(config.passwordAuthEnabled, true);
		assert.equal(config.signupsEnabled, true);
	});

	await t.step("an account is created in its object, and bad logins are refused", "do-state", async () => {
		token = await session(async (api) => {
			const created = await api.createAccount("ada", "Ada", hashOf("correct horse"));
			assert.ok(created !== null);
			assert.equal(await api.createAccount("ada", "Other", hashOf("another")), null);
			assert.equal(await api.login("ada", hashOf("wrong password")), null);
			const loggedIn = await api.login("ada", hashOf("correct horse"));
			assert.ok(loggedIn !== null);
			return loggedIn;
		});
		await session(async (api) => {
			await assert.rejects(async () => {
				await api.authenticate("ada:not-the-token");
			});
		});
	});

	await t.step("a session changes the user's profile, and a later session reads it", "do-state", async () => {
		await session(async (api) => {
			const user = await api.authenticate(token);
			await user.setOwnDisplayName("Ada Lovelace");
			assert.equal(await user.isOnboardingCompleted(), false);
			await user.completeOnboarding();
		});
		await session(async (api) => {
			const user = await api.authenticate(token);
			assert.equal((await user.whoami()).name, "Ada Lovelace");
			assert.equal(await user.isOnboardingCompleted(), true);
		});
	});

	await t.step("a second account has its own object and profile", "do-state", async () => {
		await session(async (api) => {
			const graceToken = await api.createAccount("grace", "Grace", hashOf("battery staple"));
			assert.ok(graceToken !== null);
			const grace = await api.authenticate(graceToken);
			assert.equal((await grace.whoami()).name, "Grace");
			assert.equal(await grace.isOnboardingCompleted(), false);
		});
	});

	await t.step("the account and profile come back after the objects sleep", "sleep", async () => {
		await t.waitForSleep();
		// KV and R2 are actors too, and waitForSleep returns on any actor's sleep. Let the others end.
		await t.delay(3_000);
		await session(async (api) => {
			const user = await api.authenticate(token);
			assert.equal((await user.whoami()).name, "Ada Lovelace");
		});
	});

	await t.step("a workspace is created in its Overseer object, titled, and reopened from a new session", "do-state", async () => {
		await session(async (api) => {
			const user = await api.authenticate(token);
			const workspace = await user.newWorkspace();
			await workspace.setTitle("Q3 planning");
			const metadata = await workspace.getMetadata();
			assert.equal(metadata.title, "Q3 planning");
			workspaceId = metadata.id;
			assert.ok(workspaceId);
		});
		await session(async (api) => {
			assert.equal(await titleOfWorkspace(await api.authenticate(token)), "Q3 planning");
		});
	});

	await t.step("the Overseer object sleeps once the workspace's sessions have ended", "sleep", async () => {
		await t.waitForSleep();
		await t.delay(3_000);
		await t.waitForSleep(1_000);
	});

	await t.step("the account and profile survive an orange dev and engine restart", "restart", async () => {
		await t.restart();
		await session(async (api) => {
			const user = await api.authenticate(token);
			assert.equal((await user.whoami()).name, "Ada Lovelace");
			assert.equal(await user.isOnboardingCompleted(), true);
			assert.ok(await api.login("ada", hashOf("correct horse")));
		});
	});

	t.needsSecrets("an agent answers in a workspace", "binding", ["AI provider API key"]);
};

export default scenario;
