import type { InternalObjectFetcher } from "../internal-objects.js";
import type { RateLimitOutcome } from "./object.js";

// The Rate Limiting binding. It mirrors Miniflare's client: the same option
// checks and error text, and per-call `limit` and `period` overrides of the
// configured `simple` values.
// https://github.com/cloudflare/workers-sdk/blob/be87ff0382c53a294e948e49419d25d653c50e86/packages/miniflare/src/workers/ratelimit/ratelimit.worker.ts#L16-L75

const optionKeys: ReadonlySet<string> = new Set(["key", "limit", "period"]);

// Cloudflare accepts only 10 and 60 second windows.
export const rateLimitPeriods: readonly number[] = [10, 60];

export interface RateLimitSimpleConfiguration {
	limit: number;
	period: number;
}

// Like a destructuring default, only an absent or undefined option falls back.
function option(options: object, name: string, fallback: unknown): unknown {
	const value: unknown = Reflect.get(options, name);
	return value === undefined ? fallback : value;
}

function validate(test: boolean, message: string): asserts test {
	if (!test) throw new Error(message);
}

export class RateLimit {
	readonly #fetcher: InternalObjectFetcher;
	readonly #simple: RateLimitSimpleConfiguration;

	constructor(fetcher: InternalObjectFetcher, simple: RateLimitSimpleConfiguration) {
		this.#fetcher = fetcher;
		this.#simple = simple;
	}

	async limit(options: unknown): Promise<RateLimitOutcome> {
		validate(typeof options === "object" && options !== null, "invalid rate limit options");
		const invalidProps = Object.keys(options).filter((key) => !optionKeys.has(key));
		validate(invalidProps.length === 0, `bad rate limit options: [${invalidProps.join(",")}]`);
		const key = option(options, "key", "");
		const limit = option(options, "limit", this.#simple.limit);
		const period = option(options, "period", this.#simple.period);
		validate(typeof key === "string", `invalid key: ${String(key)}`);
		validate(typeof limit === "number", `limit must be a number: ${String(limit)}`);
		validate(typeof period === "number", `period must be a number: ${String(period)}`);
		validate(rateLimitPeriods.includes(period), `unsupported period: ${period}`);
		const response = await this.#fetcher.fetch("http://ratelimit/limit", {
			body: JSON.stringify({ key, limit, period }),
			method: "POST",
		});
		if (!response.ok) {
			throw new Error(`Rate limit call failed: ${response.status} ${await response.text()}`);
		}
		const outcome: unknown = await response.json();
		validate(
			typeof outcome === "object" &&
				outcome !== null &&
				typeof Reflect.get(outcome, "success") === "boolean",
			"Rate limit backend returned an invalid outcome",
		);
		return { success: Reflect.get(outcome, "success") === true };
	}
}
