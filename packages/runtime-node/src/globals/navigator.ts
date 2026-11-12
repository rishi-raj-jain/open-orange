import { currentExecutionContext } from "../context.js";
import { fetch, type BodyInit } from "./http.js";

// Mirrors workerd's Navigator: fixed values that hide host details, with
// readonly instance properties that user code may redefine.
// https://github.com/cloudflare/workerd/blob/b73ce3ae105c35bafaaad864095079524573a465/src/workerd/api/global-scope.h#L88-L137
export class Navigator {
	declare readonly hardwareConcurrency: number;
	declare readonly language: string;
	declare readonly languages: string[];
	declare readonly platform: string;
	declare readonly userAgent: string;

	constructor() {
		const fixed = (value: unknown): PropertyDescriptor => ({ value, writable: false });
		Object.defineProperties(this, {
			hardwareConcurrency: { ...fixed(1), configurable: true, enumerable: true },
			language: { ...fixed("en"), configurable: true, enumerable: true },
			// workerd builds a new array on each read, so callers may change it.
			languages: { configurable: true, enumerable: true, get: () => ["en"] },
			platform: { ...fixed(""), configurable: true, enumerable: true },
			userAgent: { ...fixed("Cloudflare-Workers"), configurable: true, enumerable: true },
		});
	}

	// A beacon needs a request context to keep it alive, so workerd returns
	// false outside of one.
	// https://github.com/cloudflare/workerd/blob/b73ce3ae105c35bafaaad864095079524573a465/src/workerd/api/global-scope.c%2B%2B#L1272-L1289
	sendBeacon(url: string, body?: BodyInit): boolean {
		const context = currentExecutionContext();
		if (context === undefined) return false;
		context.waitUntil(
			fetch(String(url), { body: body ?? null, method: "POST" }).then(
				() => undefined,
			),
		);
		return true;
	}
}

export const navigator = new Navigator();
