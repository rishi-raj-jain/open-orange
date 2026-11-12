import assert from "node:assert/strict";
import test from "node:test";

import { differentialFixtures } from "../fixtures.js";
import {
	checkDifferentialFixtures,
	compareFixtureOutcomes,
} from "./compare.js";
import { runOrangeFixture } from "./orange.js";
import type { FixtureOutcome } from "./protocol.js";
import { runWorkerdFixture } from "./workerd.js";

test("matches normalized values and errors through workerd and Orange", async () => {
	assert.deepEqual(
		await checkDifferentialFixtures(differentialFixtures, {
			orange: runOrangeFixture,
			workerd: runWorkerdFixture,
		}),
		[],
	);
});

test("reports a deliberate differential mismatch", () => {
	const reference: FixtureOutcome = { type: "value", value: "workerd" };
	const candidate: FixtureOutcome = { type: "value", value: "orange" };
	assert.deepEqual(
		compareFixtureOutcomes("deliberate-mismatch", "value", reference, candidate),
		[
			'differential fixture deliberate-mismatch/value differed: workerd={"type":"value","value":"workerd"} orange={"type":"value","value":"orange"}',
		],
	);
});
