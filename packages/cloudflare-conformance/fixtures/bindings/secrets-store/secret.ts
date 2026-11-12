import { WorkerEntrypoint } from "cloudflare:workers";

export class SecretsStoreSecret extends WorkerEntrypoint {
	async get() {
		return "fixture-secret-value";
	}
}

export class MissingSecretsStoreSecret extends WorkerEntrypoint {
	async get() {
		throw new Error(
			'Secrets Store binding "MISSING_SECRET" is not configured locally',
		);
	}
}
