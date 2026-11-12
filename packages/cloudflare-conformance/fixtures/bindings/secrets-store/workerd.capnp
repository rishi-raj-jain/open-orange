using Workerd = import "/workerd/workerd.capnp";

const config :Workerd.Config = (
	services = [
		(
			name = "main",
			worker = (
				compatibilityDate = "2026-09-03",
				compatibilityFlags = [],
				bindings = [
					(
						name = "PRESENT_SECRET",
						service = (name = "secrets", entrypoint = "SecretsStoreSecret")
					),
					(
						name = "MISSING_SECRET",
						service = (name = "secrets", entrypoint = "MissingSecretsStoreSecret")
					)
				],
				modules = [(name = "worker", esModule = embed "worker.ts")]
			)
		),
		(
			name = "secrets",
			worker = (
				compatibilityDate = "2026-09-03",
				compatibilityFlags = [],
				modules = [(name = "secret", esModule = embed "secret.ts")]
			)
		)
	],
	sockets = [(
		name = "http",
		address = "127.0.0.1:0",
		http = (),
		service = "main"
	)]
);
