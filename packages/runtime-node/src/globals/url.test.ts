import assert from "node:assert/strict";
import test from "node:test";

import { URL, URLSearchParams } from "./url.js";

test("parses and mutates URLs with live search parameters", () => {
	const url = new URL("/items?tag=one", "https://example.com/base");
	url.searchParams.append("tag", "two");
	url.pathname = "/other";

	assert.equal(url.origin, "https://example.com");
	assert.equal(url.href, "https://example.com/other?tag=one&tag=two");
	assert.deepEqual(url.searchParams.getAll("tag"), ["one", "two"]);
	assert.equal(URL.canParse("/relative", "https://example.com"), true);
	assert.equal(URL.parse(":invalid"), null);
});

test("implements URLSearchParams iteration and mutation", () => {
	const params = new URLSearchParams([
		["b", "2"],
		["a", "1"],
		["a", "3"],
	]);
	params.delete("a", "1");
	params.sort();

	assert.equal(params.size, 2);
	assert.deepEqual([...params], [
		["a", "3"],
		["b", "2"],
	]);
});
