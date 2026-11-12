import { deserialize } from "node:v8";
import { serializeUnshared } from "../../internal/v8-serialize.js";

// `ctx.exports.X` for a Durable Object class without a namespace is a LoopbackDurableObjectClass:
// a function that a facet's startup options accept as `class`, and that returns a
// DurableObjectClass carrying `props` when called with `{ props }`. The facet sees those props as
// `ctx.props`. Props are cloned when the class is made, so an uncloneable value throws there.
// https://github.com/cloudflare/workerd/blob/b73ce3ae105c35bafaaad864095079524573a465/src/workerd/server/server.c%2B%2B#L3575-L3597
// https://github.com/cloudflare/workerd/blob/b73ce3ae105c35bafaaad864095079524573a465/src/workerd/api/actor.h#L438-L465

export interface DurableObjectClassTarget {
	readonly className: string;
	/** The class's props as base64 V8 serialization, or undefined for `{}`. */
	readonly props: string | undefined;
}

const targets = new WeakMap<object, DurableObjectClassTarget>();

class DurableObjectClass {
	get [Symbol.toStringTag](): string {
		return "DurableObjectClass";
	}
}

const optionsError =
	"Failed to execute '(called as function)' on 'LoopbackDurableObjectClass': parameter 1 is not of type 'Options'.";

export function createLoopbackDurableObjectClass(className: string): object {
	const loopback = function LoopbackDurableObjectClass(options: unknown): object {
		if (typeof options !== "object" || options === null) throw new TypeError(optionsError);
		const props: unknown = Reflect.get(options, "props");
		const handle = new DurableObjectClass();
		targets.set(handle, { className, props: props === undefined ? undefined : encodeProps(props) });
		return handle;
	};
	Object.defineProperty(loopback, Symbol.toStringTag, { value: "LoopbackDurableObjectClass" });
	targets.set(loopback, { className, props: undefined });
	return loopback;
}

export function durableObjectClassTarget(value: unknown): DurableObjectClassTarget | undefined {
	return (typeof value === "function" || typeof value === "object") && value !== null
		? targets.get(value)
		: undefined;
}

function encodeProps(props: unknown): string {
	try {
		return Buffer.from(serializeUnshared(props)).toString("base64");
	} catch (error: unknown) {
		throw new DOMException(
			error instanceof Error ? error.message : "Value could not be cloned.",
			"DataCloneError",
		);
	}
}

/** A fresh copy of a class's props for one construction. */
export function decodeDurableObjectProps(props: string | undefined): unknown {
	return props === undefined ? {} : deserialize(Buffer.from(props, "base64"));
}
