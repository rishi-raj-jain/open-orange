import assert from "node:assert/strict";
import test from "node:test";

import {
	createWranglerHelpInventory,
	normalizeHelp,
} from "./wrangler-help.js";

const helpByPath = new Map([
	[
		"",
		`wrangler\r
\r
COMMANDS\r
  wrangler alpha       Run alpha   \r
  wrangler group       Manage group\r
`,
	],
	["alpha", "wrangler alpha\n\nRun alpha\n"],
	[
		"group",
		`wrangler group

COMMANDS
  wrangler group child <value>  Run child
`,
	],
	[
		"group child",
		`wrangler group child <value>

POSITIONALS
  value  Input value  [string] [required]

EXAMPLE
  wrangler imaginary value  This is prose, not a command listing
`,
	],
]);

test("walks and normalizes every reachable help endpoint", async () => {
	const runHelp = async (path: readonly string[]): Promise<string> => {
		const output = helpByPath.get(path.join(" "));
		assert.ok(output !== undefined, `unexpected help path: ${path.join(" ")}`);
		return output;
	};

	const first = await createWranglerHelpInventory(runHelp, "4.129.0");
	const second = await createWranglerHelpInventory(runHelp, "4.129.0");

	assert.deepEqual(second, first);
	assert.deepEqual(
		first.commands.map((command) => command.path.join(" ")),
		["", "alpha", "group", "group child"],
	);
	assert.deepEqual(first.commands[0]?.children, ["alpha", "group"]);
	assert.deepEqual(first.commands[2]?.children, ["group child"]);
	assert.equal(first.commands[3]?.invocation, "wrangler group child <value>");
	assert.equal(normalizeHelp("\u001b[31mwrangler\u001b[0m   \r\n"), "wrangler\n");
});
