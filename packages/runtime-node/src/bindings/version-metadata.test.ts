import assert from "node:assert/strict";
import test from "node:test";

import { createWorkerVersionMetadata } from "./version-metadata.js";

const input = {
	builtAt: new Date("2026-09-04T12:34:56.000Z"),
	normalizedConfiguration: '{"compatibility_date":"2026-09-03"}',
	workerBundle: new TextEncoder().encode("export default { fetch() {} }").slice(),
};

test("creates deterministic development version metadata", () => {
	const first = createWorkerVersionMetadata(input);
	const second = createWorkerVersionMetadata({
		...input,
		builtAt: new Date(input.builtAt),
		workerBundle: input.workerBundle.slice(),
	});

	assert.deepEqual(first, second);
	assert.match(first.id, /^[a-f0-9]{64}$/);
	assert.equal(first.tag, "dev");
	assert.equal(first.timestamp, "2026-09-04T12:34:56.000Z");
});

test("changes the version ID when code or configuration changes", () => {
	const reference = createWorkerVersionMetadata(input);
	const changedBundle = createWorkerVersionMetadata({
		...input,
		workerBundle: new TextEncoder().encode("different bundle"),
	});
	const changedConfiguration = createWorkerVersionMetadata({
		...input,
		normalizedConfiguration: "{}",
	});

	assert.notEqual(changedBundle.id, reference.id);
	assert.notEqual(changedConfiguration.id, reference.id);
	assert.equal(changedBundle.timestamp, reference.timestamp);
});

test("rejects an invalid build timestamp", () => {
	assert.throws(
		() =>
			createWorkerVersionMetadata({
				...input,
				builtAt: new Date(Number.NaN),
			}),
		RangeError,
	);
});
