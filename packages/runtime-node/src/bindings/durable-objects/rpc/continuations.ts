import { randomBytes } from "node:crypto";

import {
	disposeRpcValueExternals,
	type RpcValueEnvelope,
} from "./codec.js";

export const DEFAULT_RPC_CONTINUATION_TTL_MS = 30_000;

export interface DurableObjectRpcContinuation {
	readonly expiresAt: number;
	readonly token: string;
}

export interface DurableObjectRpcContinuationStoreOptions {
	readonly ttlMs?: number;
}

interface ContinuationEntry {
	readonly envelope: RpcValueEnvelope;
	readonly expiresAt: number;
	readonly timer: ReturnType<typeof setTimeout>;
}

export class DurableObjectRpcContinuationStore {
	readonly #entries = new Map<string, ContinuationEntry>();
	readonly #ttlMs: number;
	#disposed = false;

	constructor(options: DurableObjectRpcContinuationStoreOptions = {}) {
		this.#ttlMs = options.ttlMs ?? DEFAULT_RPC_CONTINUATION_TTL_MS;
		if (!Number.isSafeInteger(this.#ttlMs) || this.#ttlMs <= 0) {
			throw new RangeError("RPC continuation TTL must be a positive integer");
		}
	}

	get size(): number {
		return this.#entries.size;
	}

	retain(envelope: RpcValueEnvelope): DurableObjectRpcContinuation {
		if (this.#disposed) {
			throw new Error("Durable Object RPC generation has ended");
		}
		if (envelope.externals.length === 0) {
			throw new Error("Only RPC values with live externals need continuation storage");
		}
		let token: string;
		do {
			token = randomBytes(32).toString("base64url");
		} while (this.#entries.has(token));
		const expiresAt = Date.now() + this.#ttlMs;
		const timer = setTimeout(() => {
			this.release(token).catch(() => undefined);
		}, this.#ttlMs);
		timer.unref();
		this.#entries.set(token, { envelope, expiresAt, timer });
		return { expiresAt, token };
	}

	claim(token: string): RpcValueEnvelope {
		if (this.#disposed) {
			throw new Error("Durable Object RPC generation has ended");
		}
		const entry = this.#entries.get(token);
		if (entry === undefined) {
			throw new Error("Durable Object RPC continuation is missing, expired, or claimed");
		}
		this.#entries.delete(token);
		clearTimeout(entry.timer);
		return entry.envelope;
	}

	async release(token: string): Promise<boolean> {
		const entry = this.#entries.get(token);
		if (entry === undefined) return false;
		this.#entries.delete(token);
		clearTimeout(entry.timer);
		await disposeRpcValueExternals(entry.envelope);
		return true;
	}

	async dispose(): Promise<void> {
		if (this.#disposed) return;
		this.#disposed = true;
		const entries = [...this.#entries.values()];
		this.#entries.clear();
		for (const entry of entries) clearTimeout(entry.timer);
		const results = await Promise.allSettled(
			entries.map((entry) => disposeRpcValueExternals(entry.envelope)),
		);
		const failures: unknown[] = [];
		for (const result of results) {
			if (result.status === "rejected") failures.push(result.reason);
		}
		if (failures.length !== 0) {
			throw new AggregateError(
				failures,
				"Failed to release Durable Object RPC generation",
			);
		}
	}
}

// A continuation is an Orange transport handoff, not a second RPC execution.
// Its external table retains the same live capabilities that workerd carries
// beside the V8 graph until they are transferred or released.
// https://github.com/cloudflare/workerd/blob/dc27e996c4ab8e8849cc6229ae816b3d426f08ef/src/workerd/io/worker-interface.capnp#L562-L668
