import { createSecretsStoreSecret } from "./secrets-store.js";
import { createWorkerVersionMetadata } from "./version-metadata.js";

export const bindingFactories = {
	secrets_store_secret: createSecretsStoreSecret,
	version_metadata: createWorkerVersionMetadata,
};
