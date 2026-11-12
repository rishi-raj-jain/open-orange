export function createUnimplementedGlobal(name: string): unknown {
	function fail(): never {
		throw new Error(`Cloudflare global ${name} is not implemented by OpenOrange`);
	}

	return new Proxy(fail, {
		apply: fail,
		construct: fail,
		get: fail,
		set: fail,
	});
}
