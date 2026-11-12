import assert from "node:assert/strict";
import test from "node:test";

import { run } from "./bin.js";

function captureIo(): {
	io: { log(message: string): void; error(message: string): void };
	logs: string[];
	errors: string[];
} {
	const logs: string[] = [];
	const errors: string[] = [];
	return {
		io: {
			log: (message) => logs.push(message),
			error: (message) => errors.push(message),
		},
		logs,
		errors,
	};
}

test("lists the generate, check, and upstream commands", async () => {
	const { io, logs, errors } = captureIo();
	assert.equal(await run(["--help"], io), 0);
	assert.deepEqual(errors, []);
	assert.match(logs.join("\n"), /generate/);
	assert.match(logs.join("\n"), /check/);
	assert.match(logs.join("\n"), /upstream/);
});

test("dispatches runtime declaration generation", async () => {
	const { io, errors } = captureIo();
	let generated = false;
	assert.equal(
		await run(["generate"], io, {
			check: async () => {},
			generate: async () => {
				generated = true;
			},
			upstream: async () => {},
			saveResults: async () => {},
			realProjects: async () => {},
			exampleResults: async () => {},
			truthTable: async () => {},
		}),
		0,
	);
	assert.equal(generated, true);
	assert.deepEqual(errors, []);
});

test("rejects unknown commands", async () => {
	const { io, errors } = captureIo();
	assert.equal(await run(["unknown"], io), 2);
	assert.match(errors[0] ?? "", /Unknown command/);
});

test("rejects an unknown upstream binding kind before running anything", async () => {
	const { io, errors } = captureIo();
	assert.equal(await run(["upstream", "--bindings", "service,not-a-kind"], io), 1);
	assert.match(errors[0] ?? "", /Unknown binding kind "not-a-kind"/);
});
