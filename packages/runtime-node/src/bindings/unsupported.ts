// Wrangler binding types that OpenOrange accepts in configuration but cannot
// back locally. The Worker still loads, and `env.NAME` is a stub whose members
// throw on call, so code paths that never touch the binding keep working.

interface UnsupportedBindingDescription {
	label: string;
	alternative?: string;
}

const describedBindingTypes: Readonly<Record<string, UnsupportedBindingDescription>> = {
	ai_search: { label: "AI Search" },
	ai_search_namespace: { label: "AI Search namespace" },
	// Browser Rendering and Send Email are supported. The runner uses these two
	// entries for the stub it binds when their setting is missing.
	browser: {
		alternative:
			"Set ORANGE_BROWSER_CDP_URL to a Chrome DevTools Protocol endpoint, such as wss://connect.browserbase.com?apiKey=<key> or http://127.0.0.1:9222 of a headless Chrome.",
		label: "Browser Rendering",
	},
	data_blob: { label: "Data blob" },
	durable_object_namespace: {
		alternative:
			"Set script_name to the Worker that exports the class and pass its configuration to orange dev with another -c.",
		label: "Durable Object namespace",
	},
	images: { label: "Images" },
	logfwdr: { label: "Log forwarding" },
	media: { label: "Media Transformations" },
	mtls_certificate: { label: "mTLS certificate" },
	pipeline: { label: "Pipelines" },
	send_email: {
		alternative:
			"Set ORANGE_EMAIL_SMTP_URL to your SMTP server, such as smtp://user:password@smtp.example.com:587, or send email through your provider's HTTP API with fetch().",
		label: "Send Email",
	},
	stream: { label: "Stream" },
	text_blob: { label: "Text blob" },
	// The replacement that docs/modules/bindings.mdx "Other bindings" gives.
	vectorize: {
		alternative:
			"Call a vector database, such as Qdrant Cloud or Pinecone, with fetch(), or use pgvector through Hyperdrive. For a few thousand vectors, store the embeddings in SQLite and rank them by cosine similarity in JavaScript.",
		label: "Vectorize",
	},
	vpc_network: { label: "VPC network" },
	vpc_service: { label: "VPC service" },
	wasm_module: {
		alternative: "Import the WebAssembly module from the Worker source instead.",
		label: "Wasm module",
	},
};

// The alternative for a type that has no better one. It only points at the docs.
export const defaultUnsupportedBindingAlternative =
	"See the OpenOrange bindings documentation for supported bindings.";

// The product name for a Wrangler binding type, such as `Vectorize` for `vectorize`.
export function unsupportedBindingLabel(bindingType: string): string {
	return describedBindingTypes[bindingType]?.label ?? bindingType;
}

// What to use instead of a stubbed binding, as one sentence.
export function unsupportedBindingAlternative(bindingType: string): string {
	return describedBindingTypes[bindingType]?.alternative ?? defaultUnsupportedBindingAlternative;
}

// For example: `Vectorize binding "VECTORS" is not supported by OpenOrange.
// See the OpenOrange bindings documentation ...`. A target names what the
// binding points at, such as `Worker "auth"` for a cross-Worker Durable Object.
export function unsupportedBindingMessage(
	bindingType: string,
	bindingName: string,
	target?: string,
): string {
	const label = unsupportedBindingLabel(bindingType);
	const subject = target === undefined ? "" : ` to ${target}`;
	return `${label} binding ${JSON.stringify(bindingName)}${subject} is not supported by OpenOrange. ${unsupportedBindingAlternative(bindingType)}`;
}

class UnsupportedBinding {}

const objectPrototypeMembers: ReadonlySet<string> = new Set(
	Object.getOwnPropertyNames(Object.prototype),
);

// Members that runtimes, serializers, and `await` probe without intending a
// binding call. They read as absent so inspecting the stub never throws.
const absentMembers: ReadonlySet<string> = new Set(["then", "toJSON"]);

export function createUnsupportedBinding(message: string): object {
	const members = new Map<string, () => never>();
	return new Proxy(new UnsupportedBinding(), {
		get(target, property, receiver): unknown {
			if (typeof property === "symbol") {
				return property === Symbol.toStringTag
					? "UnsupportedBinding"
					: Reflect.get(target, property, receiver);
			}
			if (absentMembers.has(property)) return undefined;
			if (objectPrototypeMembers.has(property)) {
				return Reflect.get(target, property, receiver);
			}
			let member = members.get(property);
			if (member === undefined) {
				member = (): never => {
					throw new Error(message);
				};
				members.set(property, member);
			}
			return member;
		},
	});
}
