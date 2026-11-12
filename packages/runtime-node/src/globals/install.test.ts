import assert from "node:assert/strict";
import test from "node:test";

import {
	installCloudflareGlobals,
	installCloudflareGlobalsBeforeImport,
} from "./install.js";
import { globalManifest } from "./manifest.js";

test("installs implementations and throwing placeholders from the manifest", () => {
	const target = { atob: "host implementation" };
	installCloudflareGlobals(target);

	assert.equal(globalManifest.length, 83);
	for (const entry of globalManifest) {
		assert.equal(Object.hasOwn(target, entry.name), true);
		const descriptor = Object.getOwnPropertyDescriptor(target, entry.name);
		assert.ok(descriptor);
		if (entry.status === "unimplemented") {
			assert.equal(typeof descriptor.value, "function");
			assert.throws(
				() => Reflect.apply(descriptor.value, undefined, []),
				new RegExp(`Cloudflare global ${entry.name} is not implemented`),
			);
		} else {
			assert.ok(
				typeof descriptor.value === "function" ||
					(typeof descriptor.value === "object" && descriptor.value !== null),
			);
		}
	}
	const installedAtob: unknown = Reflect.get(target, "atob");
	if (typeof installedAtob !== "function") {
		throw new Error("atob implementation was not installed");
	}
	assert.equal(Reflect.apply(installedAtob, undefined, ["YQ=="]), "a");

	const InstalledTextEncoder: unknown = Reflect.get(target, "TextEncoder");
	if (typeof InstalledTextEncoder !== "function") {
		throw new Error("TextEncoder implementation was not installed");
	}
	const encoder: unknown = Reflect.construct(InstalledTextEncoder, []);
	if (typeof encoder !== "object" || encoder === null) {
		throw new Error("TextEncoder implementation did not construct an object");
	}
	assert.equal(Reflect.get(encoder, "encoding"), "utf-8");

	const InstalledDOMException: unknown = Reflect.get(target, "DOMException");
	if (typeof InstalledDOMException !== "function") {
		throw new Error("DOMException implementation was not installed");
	}
	const exception: unknown = Reflect.construct(InstalledDOMException, [
		"fixture",
		"DataCloneError",
	]);
	if (typeof exception !== "object" || exception === null) {
		throw new Error("DOMException did not construct an object");
	}
	const isError: unknown = Reflect.get(InstalledDOMException, "isError");
	if (typeof isError !== "function") {
		throw new Error("DOMException.isError was not installed");
	}
	assert.equal(Reflect.apply(isError, InstalledDOMException, [exception]), true);
	assert.equal(Reflect.get(exception, "name"), "DataCloneError");
});

test("installs globals before evaluating the Worker import", async () => {
	const target = {};
	let evaluated = false;
	const result = await installCloudflareGlobalsBeforeImport(async () => {
		evaluated = true;
		assert.ok(globalManifest.every((entry) => Object.hasOwn(target, entry.name)));
		return "loaded";
	}, target);

	assert.equal(evaluated, true);
	assert.equal(result, "loaded");
});
