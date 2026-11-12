// Placeholders let a Worker that imports these names load. Each one throws
// when it is used.
export function restore(): never {
	throw new Error("cloudflare:workers restore() is not implemented by OpenOrange");
}
