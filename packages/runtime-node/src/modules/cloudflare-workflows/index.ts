// The cloudflare:workflows module.
// https://github.com/cloudflare/workerd/blob/b73ce3ae105c35bafaaad864095079524573a465/src/cloudflare/internal/workflows-api.ts#L7-L12

export class NonRetryableError extends Error {
	constructor(message: string, name = "NonRetryableError") {
		super(message);
		this.name = name;
	}
}

export default { NonRetryableError };
