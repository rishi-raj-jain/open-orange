// The cloudflare:ai module. The error classes behave as in workerd. The
// service classes need Cloudflare's AI backend, which Orange does not have, so
// constructing one throws. Workers that only import these names load and run.
// https://github.com/cloudflare/workerd/blob/b73ce3ae105c35bafaaad864095079524573a465/src/cloudflare/ai.ts#L5-L33

function backendUnavailable(className: string): Error {
	const error = new Error(
		`cloudflare:ai ${className} is not implemented by OpenOrange because it needs Cloudflare's AI service. Call the model provider's HTTP API with fetch().`,
	);
	error.name = "NotSupportedError";
	return error;
}

// https://github.com/cloudflare/workerd/blob/b73ce3ae105c35bafaaad864095079524573a465/src/cloudflare/internal/ai-api.ts#L91-L96
export class InferenceUpstreamError extends Error {
	constructor(message: string, name = "InferenceUpstreamError") {
		super(message);
		this.name = name;
	}
}

// https://github.com/cloudflare/workerd/blob/b73ce3ae105c35bafaaad864095079524573a465/src/cloudflare/internal/aig-api.ts#L118-L130
export class AiGatewayInternalError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "AiGatewayInternalError";
	}
}

export class AiGatewayLogNotFound extends Error {
	constructor(message: string) {
		super(message);
		this.name = "AiGatewayLogNotFound";
	}
}

// https://github.com/cloudflare/workerd/blob/b73ce3ae105c35bafaaad864095079524573a465/src/cloudflare/internal/autorag-api.ts#L9-L28
export class AutoRAGInternalError extends Error {
	constructor(message: string, name = "AutoRAGInternalError") {
		super(message);
		this.name = name;
	}
}

export class AutoRAGNotFoundError extends Error {
	constructor(message: string, name = "AutoRAGNotFoundError") {
		super(message);
		this.name = name;
	}
}

export class AutoRAGUnauthorizedError extends Error {
	constructor(message: string, name = "AutoRAGUnauthorizedError") {
		super(message);
		this.name = name;
	}
}

export class Ai {
	constructor(_fetcher: unknown) {
		throw backendUnavailable("Ai");
	}
}

export class AiGateway {
	constructor(_fetcher: unknown, _gatewayId: string) {
		throw backendUnavailable("AiGateway");
	}
}

export class AutoRAG {
	constructor(_fetcher: unknown, _autoragId?: string) {
		throw backendUnavailable("AutoRAG");
	}
}

export class ToMarkdownService {
	constructor(_fetcher: unknown) {
		throw backendUnavailable("ToMarkdownService");
	}
}
