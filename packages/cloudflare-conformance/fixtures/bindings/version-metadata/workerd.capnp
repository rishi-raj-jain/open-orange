using Workerd = import "/workerd/workerd.capnp";

const config :Workerd.Config = (
	services = [(
		name = "main",
		worker = (
			compatibilityDate = "2026-09-03",
			compatibilityFlags = [],
			bindings = [(
				name = "VERSION_METADATA",
				json = "{\"id\":\"90f7e6650479f8c9b814b625138a67111df3864f5ae97a28181b6a76cf83705c\",\"tag\":\"dev\",\"timestamp\":\"2026-09-04T12:34:56.000Z\"}"
			)],
			modules = [(
				name = "worker",
				esModule = embed "worker.ts"
			)]
		)
	)],
	sockets = [(
		name = "http",
		address = "127.0.0.1:0",
		http = (),
		service = "main"
	)]
);
