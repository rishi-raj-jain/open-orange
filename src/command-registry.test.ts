import assert from "node:assert/strict";
import test from "node:test";

import { commandRegistry, commands } from "./command-registry.js";

test("registers every pinned Wrangler help endpoint", () => {
	assert.equal(commands.length, 426);
	assert.equal(commandRegistry.size, 426);
	assert.ok(commandRegistry.has(""));
	assert.ok(commandRegistry.has("d1 migrations create"));
	assert.ok(commandRegistry.has("vectorize query"));
});

test("extracts positionals, aliases, choices, and defaults", () => {
	const migration = commandRegistry.get("d1 migrations create");
	assert.ok(migration);
	assert.deepEqual(
		migration.positionals.map((parameter) => ({
			name: parameter.names[0],
			required: parameter.required,
			type: parameter.type,
		})),
		[
			{ name: "database", required: true, type: "string" },
			{ name: "message", required: true, type: "string" },
		],
	);

	const query = commandRegistry.get("vectorize query");
	assert.ok(query);
	const returnMetadata = query.options.find((option) =>
		option.names.includes("--return-metadata"),
	);
	assert.deepEqual(returnMetadata?.choices, '"all", "indexed", "none"');
	assert.equal(returnMetadata?.defaultValue, '"none"');

	const config = query.options.find((option) => option.names.includes("--config"));
	assert.deepEqual(config?.names, ["-c", "--config"]);
	assert.equal(config?.scope, "global");
});
