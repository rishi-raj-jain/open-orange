// `request_signal_passthrough`: an incoming request's signal also follows its copies. Without it,
// which is the default, a copy passed to a subrequest or over RPC doesn't see the disconnect.
// https://github.com/cloudflare/workerd/blob/b73ce3ae105c35bafaaad864095079524573a465/src/workerd/api/basics.c%2B%2B#L1300
let enabled = false;

export function setRequestSignalPassthrough(value: boolean): void {
	enabled = value;
}

export function isRequestSignalPassthrough(): boolean {
	return enabled;
}
