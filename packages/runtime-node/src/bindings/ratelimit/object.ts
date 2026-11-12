import type { InternalObjectState } from "../internal-objects.js";

// The Rate Limiting backend: one internal Durable Object per `namespace_id`,
// holding fixed-window counters in its SQLite storage. Counters live in storage
// rather than on the heap because the actor can sleep between calls. This
// mirrors Miniflare's RateLimiterObject: one row per `(key, period)`, a window
// aligned to the wall clock, and expired windows deleted on rollover. The
// client in ./binding.ts validates every request first.
// https://github.com/cloudflare/workers-sdk/blob/be87ff0382c53a294e948e49419d25d653c50e86/packages/miniflare/src/workers/ratelimit/ratelimit-object.worker.ts#L24-L106

export interface RateLimitRequest {
	key: string;
	limit: number;
	period: number;
}

export interface RateLimitOutcome {
	success: boolean;
}

type BucketRow = {
	count: number;
	epoch: number;
};

function parseRequest(value: unknown): RateLimitRequest {
	if (typeof value !== "object" || value === null) {
		throw new TypeError("Invalid rate limit request");
	}
	const key: unknown = Reflect.get(value, "key");
	const limit: unknown = Reflect.get(value, "limit");
	const period: unknown = Reflect.get(value, "period");
	if (typeof key !== "string" || typeof limit !== "number" || typeof period !== "number") {
		throw new TypeError("Invalid rate limit request");
	}
	return { key, limit, period };
}

export class RateLimitObject {
	readonly #state: InternalObjectState;
	#schemaReady = false;

	constructor(state: InternalObjectState) {
		this.#state = state;
	}

	#sql(): InternalObjectState["storage"]["sql"] {
		const sql = this.#state.storage.sql;
		if (!this.#schemaReady) {
			sql.exec(
				"CREATE TABLE IF NOT EXISTS openorange_ratelimit_buckets (key TEXT NOT NULL, period INTEGER NOT NULL, epoch INTEGER NOT NULL, count INTEGER NOT NULL, PRIMARY KEY (key, period)) WITHOUT ROWID",
			);
			// Rollover deletes by period and epoch, so it must not scan every key.
			sql.exec(
				"CREATE INDEX IF NOT EXISTS openorange_ratelimit_buckets_epoch ON openorange_ratelimit_buckets (period, epoch)",
			);
			this.#schemaReady = true;
		}
		return sql;
	}

	async fetch(request: Request): Promise<Response> {
		const url = new URL(request.url);
		if (request.method !== "POST" || url.pathname !== "/limit") {
			return new Response(null, { status: 404 });
		}
		const { key, limit, period } = parseRequest(await request.json());
		// The read, rollover, and increment run synchronously in one transaction,
		// so overlapping calls on one key never read the same count.
		const success = this.#state.storage.transactionSync(() => {
			const sql = this.#sql();
			const epoch = Math.floor(Date.now() / (period * 1000));
			const bucket = sql
				.exec<BucketRow>(
					"SELECT epoch, count FROM openorange_ratelimit_buckets WHERE key = ? AND period = ?",
					key,
					period,
				)
				.toArray()[0];
			let count = 0;
			if (bucket !== undefined && bucket.epoch === epoch) {
				count = bucket.count;
			} else {
				// Windows align to the wall clock, so every key with this period
				// rolls over at once.
				sql.exec(
					"DELETE FROM openorange_ratelimit_buckets WHERE period = ? AND epoch < ?",
					period,
					epoch,
				);
			}
			if (count >= limit) return false;
			sql.exec(
				"INSERT OR REPLACE INTO openorange_ratelimit_buckets (key, period, epoch, count) VALUES (?, ?, ?, ?)",
				key,
				period,
				epoch,
				count + 1,
			);
			return true;
		});
		return Response.json({ success } satisfies RateLimitOutcome);
	}
}
