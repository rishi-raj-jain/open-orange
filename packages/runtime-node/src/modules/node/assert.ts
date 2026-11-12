import nodeAssert from "node:assert";

// Node's assert is used as is, except for rejects() and doesNotReject().
// workerd's accept any thenable, but Node's reject callable thenables such as
// RpcPromise.
// https://github.com/cloudflare/workerd/blob/b73ce3ae105c35bafaaad864095079524573a465/src/node/internal/internal_assert.ts#L684-L790

function isThenable(value: unknown): value is PromiseLike<unknown> {
	return (
		(typeof value === "object" || typeof value === "function") &&
		value !== null &&
		typeof Reflect.get(value, "then") === "function"
	);
}

function asPromise(asyncFn: unknown): unknown {
	if (typeof asyncFn === "function") {
		return (): unknown => {
			const result: unknown = asyncFn();
			return isThenable(result) ? Promise.resolve(result) : result;
		};
	}
	return isThenable(asyncFn) ? Promise.resolve(asyncFn) : asyncFn;
}

export function rejects(asyncFn: unknown, ...args: unknown[]): Promise<void> {
	return Reflect.apply(nodeAssert.rejects, nodeAssert, [asPromise(asyncFn), ...args]);
}

export function doesNotReject(asyncFn: unknown, ...args: unknown[]): Promise<void> {
	return Reflect.apply(nodeAssert.doesNotReject, nodeAssert, [
		asPromise(asyncFn),
		...args,
	]);
}

function thenableAssert<T extends (...args: never[]) => unknown>(base: T, strictAssert?: Function): T {
	const assert = Object.assign(base.bind(undefined), base, { doesNotReject, rejects });
	return Object.assign(assert, { strict: strictAssert ?? assert });
}

export const strict = thenableAssert(nodeAssert.strict);

const assert = thenableAssert(nodeAssert, strict);

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
} = assert;

// Node 24 has partialDeepStrictEqual, but @types/node does not declare it yet.
export const partialDeepStrictEqual: typeof deepStrictEqual = Reflect.get(
	assert,
	"partialDeepStrictEqual",
);

// Node 24 exports these classes, but @types/node does not declare them yet.
export const Assert: unknown = Reflect.get(assert, "Assert");
export const CallTracker: unknown = Reflect.get(assert, "CallTracker");

export default assert;
