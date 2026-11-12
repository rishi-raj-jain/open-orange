import { doesNotReject, rejects, strict } from "./assert.js";

// `node:assert/strict` is the strict mode of `node:assert`.

export const {
	AssertionError,
	deepEqual,
	deepStrictEqual,
	doesNotMatch,
	doesNotThrow,
	equal,
	fail,
	ifError,
	match,
	notDeepEqual,
	notDeepStrictEqual,
	notEqual,
	notStrictEqual,
	ok,
	strictEqual,
	throws,
} = strict;

export const partialDeepStrictEqual: typeof deepStrictEqual = Reflect.get(
	strict,
	"partialDeepStrictEqual",
);

// Node 24 exports these classes, but @types/node does not declare them yet.
export const Assert: unknown = Reflect.get(strict, "Assert");
export const CallTracker: unknown = Reflect.get(strict, "CallTracker");

export { doesNotReject, rejects, strict, strict as default };
