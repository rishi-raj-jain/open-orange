const internalClass = Symbol.for("cloudflare:internal-class");

// Workerd gives every runtime class prototype a Symbol.toStringTag with the
// class name and the "cloudflare:internal-class" marker symbol.
// https://github.com/cloudflare/workerd/blob/b73ce3ae105c35bafaaad864095079524573a465/src/workerd/jsg/resource.h#L2080-L2096
export function markWorkerdClass(constructor: Function, name: string): void {
	Object.defineProperty(constructor.prototype, Symbol.toStringTag, {
		configurable: true,
		value: name,
	});
	Object.defineProperty(constructor.prototype, internalClass, {
		value: internalClass,
	});
}
