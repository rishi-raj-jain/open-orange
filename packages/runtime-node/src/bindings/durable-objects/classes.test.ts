import assert from "node:assert/strict";
import test from "node:test";

import { discoverDurableObjectClasses } from "./classes.js";
import { DurableObject } from "../../modules/cloudflare-workers/durable-object.js";

class Configured extends DurableObject {}
class Indirect extends Configured {}
class Unconfigured extends DurableObject {}
class PlainClass {}
const arrowFunction = (): void => {};

test("discovers only configured Durable Object classes", () => {
	const classes = discoverDurableObjectClasses(
		{ Configured, Indirect, PlainClass, Unconfigured },
		{
			classes: [
				{ className: "Configured" },
				{ className: "Indirect" },
				{ className: "PlainClass" },
			],
		},
	);

	assert.deepEqual([...classes.keys()], ["Configured", "Indirect", "PlainClass"]);
	assert.equal(classes.get("Configured"), Configured);
	assert.equal(classes.has("Unconfigured"), false);
});

test("rejects missing, invalid, and duplicate configured exports", () => {
	assert.throws(
		() =>
			discoverDurableObjectClasses(
				{ Configured },
				{ classes: [{ className: "Missing" }] },
			),
		/not a named Worker export/,
	);
	assert.throws(
		() =>
			discoverDurableObjectClasses(
				{ arrowFunction },
				{ classes: [{ className: "arrowFunction" }] },
			),
		/must be a class/,
	);
	assert.throws(
		() =>
			discoverDurableObjectClasses(
				{ Configured },
				{
					classes: [
						{ className: "Configured" },
						{ className: "Configured" },
					],
				},
			),
		/Duplicate configured Durable Object class/,
	);
});
