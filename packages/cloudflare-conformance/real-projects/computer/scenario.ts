import assert from "node:assert/strict";

import type { Scenario, ScenarioContext } from "../../src/real-projects/scenario.js";

interface ExecResult {
	exitCode: number;
	stdout: string;
	stderr: string;
}

function exec(t: ScenarioContext, workspace: string, command: string): Promise<ExecResult> {
	return t.json<ExecResult>(`/c/${workspace}/exec`, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ command }),
	});
}

const scenario: Scenario = async (t) => {
	await t.step("the Worker lists its routes, and refuses paths outside the workspace", "http", async () => {
		assert.match(await t.text("/"), /POST \/c\/<name>\/exec/);
		await t.text("/c/demo/file/etc/passwd", {}, 400);
	});

	await t.step("a file written through the Durable Object reads back, and each workspace is separate", "do-state", async () => {
		await t.text("/c/demo/file/workspace/hello.txt", { method: "PUT", body: "hello from a client\n" }, 204);
		assert.equal(await t.text("/c/demo/file/workspace/hello.txt"), "hello from a client\n");
		await t.text("/c/demo/file/workspace/missing.txt", {}, 404);
		await t.text("/c/other/file/workspace/hello.txt", {}, 404);
	});

	await t.step("a shell in a Dynamic Worker reads and writes the Durable Object's filesystem", "do-state", async () => {
		const read = await exec(t, "demo", "cat hello.txt");
		assert.deepEqual(read, { ...read, exitCode: 0, stdout: "hello from a client\n" });
		const piped = await exec(t, "demo", "mkdir -p notes && echo made-in-shell > notes/a.txt && ls notes && wc -l < hello.txt");
		assert.equal(piped.exitCode, 0, piped.stderr);
		assert.match(piped.stdout, /a\.txt/);
		assert.equal(await t.text("/c/demo/file/workspace/notes/a.txt"), "made-in-shell\n");
		const jq = await exec(t, "demo", `echo '{"a":41}' | jq '.a + 1'`);
		assert.equal(jq.stdout.trim(), "42");
	});

	await t.step("the skill bundled with the Worker is mounted read-only", "binding", async () => {
		const skill = await exec(t, "demo", "cat /workspace/.agents/skills/exec/SKILL.md");
		assert.equal(skill.exitCode, 0, skill.stderr);
		assert.ok(skill.stdout.length > 0);
		const write = await exec(t, "demo", "echo x > /workspace/.agents/skills/exec/SKILL.md");
		assert.notEqual(write.exitCode, 0);
	});

	await t.step("files survive the Durable Object's sleep, and the shell still runs", "sleep", async () => {
		await t.waitForSleep();
		assert.equal(await t.text("/c/demo/file/workspace/hello.txt"), "hello from a client\n");
		const read = await exec(t, "demo", "cat notes/a.txt");
		assert.equal(read.stdout, "made-in-shell\n");
	});

	await t.step("files survive a restart, and the shell still runs", "restart", async () => {
		await t.restart();
		assert.equal(await t.text("/c/demo/file/workspace/hello.txt"), "hello from a client\n");
		const read = await exec(t, "demo", "cat notes/a.txt");
		assert.equal(read.stdout, "made-in-shell\n");
	});
};

export default scenario;
