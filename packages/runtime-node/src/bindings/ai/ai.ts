import { FormData } from "undici";

import type { Response } from "../../globals/http.js";
import { InferenceUpstreamError } from "../../modules/cloudflare-ai/index.js";
import type { AiFetcher, AiFetchInit } from "./backend.js";
import { isRecord } from "../unknown-values.js";

// The Workers AI binding, `env.AI`. It ports workerd's JS client (Apache-2.0)
// and talks to OpenOrange's in-process backend instead of Cloudflare's AI
// service. The JSON request path, response handling, and error parsing follow
// workerd. ReadableStream inputs, WebSocket mode, AI Gateway methods, AutoRAG,
// AI Search, and toMarkdown throw `NotSupportedError`.
// https://github.com/cloudflare/workerd/blob/b73ce3ae105c35bafaaad864095079524573a465/src/cloudflare/internal/ai-api.ts#L137-L467

export interface AiOptions {
	extraHeaders?: object;
	gateway?: { id: string } & Record<string, unknown>;
	prefix?: string;
	returnRawResponse?: boolean;
	sessionOptions?: { extraHeaders?: object };
	signal?: AbortSignal;
	websocket?: boolean;
}

export interface AiModelsSearchParams {
	author?: string;
	hide_experimental?: boolean;
	page?: number;
	per_page?: number;
	search?: string;
	source?: number;
	task?: string;
}

// https://github.com/cloudflare/workerd/blob/b73ce3ae105c35bafaaad864095079524573a465/src/cloudflare/internal/ai-api.ts#L98-L103
export class AiInternalError extends Error {
	constructor(message: string, name = "AiInternalError") {
		super(message);
		this.name = name;
	}
}

function notSupported(feature: string, alternative: string): Error {
	const error = new Error(`${feature} is not supported by OpenOrange. ${alternative}`);
	error.name = "NotSupportedError";
	return error;
}

function hasStreamInput(inputs: Record<string, unknown>): boolean {
	return Object.values(inputs).some(
		(value) =>
			value instanceof ReadableStream ||
			value instanceof FormData ||
			(isRecord(value) &&
				(value.body instanceof ReadableStream || value.body instanceof FormData)),
	);
}

const endpointUrl = "https://workers-binding.ai";

export class Ai {
	readonly #fetcher: AiFetcher;
	lastRequestId: string | null = null;
	aiGatewayLogId: string | null = null;
	lastRequestHttpStatusCode: number | null = null;
	lastRequestInternalStatusCode: number | null = null;

	constructor(fetcher: AiFetcher) {
		this.#fetcher = fetcher;
	}

	async fetch(input: string | URL, init?: AiFetchInit): Promise<Response> {
		return this.#fetcher.fetch(input, init);
	}

	// Unlike workerd, which stores `options` on the binding while the request is
	// in flight, each call keeps its own options, so overlapping calls on the
	// shared `env.AI` never see each other's options.
	async run(
		model: string,
		inputs: Record<string, unknown>,
		options: AiOptions = {},
	): Promise<Response | ReadableStream<Uint8Array> | object | null> {
		this.lastRequestId = "";
		if (options.websocket === true) {
			throw notSupported(
				"Workers AI WebSocket mode",
				"Call run() without `websocket` to use the provider over HTTP.",
			);
		}
		if (hasStreamInput(inputs)) {
			throw notSupported(
				"Workers AI ReadableStream and FormData inputs",
				"OpenOrange maps only text generation and embedding models, which take JSON inputs.",
			);
		}
		const { extraHeaders, prefix, sessionOptions, signal, ...cleanedOptions } = options;
		const init: AiFetchInit = {
			body: JSON.stringify({ inputs, options: cleanedOptions }),
			headers: {
				...sessionOptions?.extraHeaders,
				...extraHeaders,
				"cf-consn-model-id": `${prefix ? `${prefix}:` : ""}${model}`,
				"cf-consn-sdk-version": "2.0.0",
				"content-type": "application/json",
			},
			method: "POST",
			...(signal === undefined ? {} : { signal }),
		};
		const path = cleanedOptions.gateway?.id ? "/ai-gateway/run" : "/run";
		const res = await this.#fetcher.fetch(`${endpointUrl}${path}?version=3`, init);

		this.lastRequestId = res.headers.get("cf-ai-req-id");
		this.aiGatewayLogId = res.headers.get("cf-aig-log-id");
		this.lastRequestHttpStatusCode = res.status;

		if (options.returnRawResponse) return res;
		if (!res.ok || !res.body) throw await this.#parseError(res);
		if (res.headers.get("content-type") === "application/json") {
			const result: unknown = await res.json();
			if (typeof result !== "object" || result === null) {
				throw new AiInternalError("Workers AI returned a JSON value that is not an object");
			}
			return result;
		}
		return res.body;
	}

	getLogs(): string[] {
		return [];
	}

	async #parseError(res: Response): Promise<InferenceUpstreamError> {
		const content = await res.text();
		try {
			const parsed: unknown = JSON.parse(content);
			if (isRecord(parsed) && typeof parsed.internalCode === "number" && parsed.internalCode !== 0) {
				this.lastRequestInternalStatusCode = parsed.internalCode;
				return new InferenceUpstreamError(
					`${parsed.internalCode}: ${String(parsed.description)}`,
					typeof parsed.name === "string" ? parsed.name : undefined,
				);
			}
			const first = isRecord(parsed) && Array.isArray(parsed.errors) ? parsed.errors[0] : undefined;
			if (isRecord(first)) {
				return new InferenceUpstreamError(`${String(first.code)}: ${String(first.message)}`);
			}
			return new InferenceUpstreamError(content);
		} catch {
			return new InferenceUpstreamError(content);
		}
	}

	async models(params: AiModelsSearchParams = {}): Promise<object[]> {
		const url = new URL(`${endpointUrl}/ai-api/models/search`);
		for (const [key, value] of Object.entries(params)) {
			url.searchParams.set(key, String(value));
		}
		const res = await this.#fetcher.fetch(url, { method: "GET" });
		const data: unknown = await res.json();
		if (res.status === 200 && isRecord(data) && Array.isArray(data.result)) {
			return data.result;
		}
		const first = isRecord(data) && Array.isArray(data.errors) ? data.errors[0] : undefined;
		throw new AiInternalError(
			isRecord(first) && typeof first.message === "string" ? first.message : "Internal Error",
		);
	}

	gateway(_gatewayId: string): never {
		throw notSupported(
			"env.AI.gateway()",
			"Pass the `gateway` option to env.AI.run() instead. OpenOrange ignores gateway caching and logs.",
		);
	}

	autorag(_autoragId?: string): never {
		throw notSupported("env.AI.autorag()", "Query your vector store with fetch().");
	}

	aiSearch(): never {
		throw notSupported("env.AI.aiSearch()", "Query your search index with fetch().");
	}

	toMarkdown(): never {
		throw notSupported("env.AI.toMarkdown()", "Convert documents with a library in the Worker.");
	}
}
