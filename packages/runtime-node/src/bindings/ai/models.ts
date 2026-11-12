import { errorMessage, isRecord } from "../unknown-values.js";

// Maps Workers AI model names to models on an OpenAI-compatible provider.

export type AiModelTask = "embeddings" | "text";

// The result shape Cloudflare returns for a text model. `legacy` is
// `{response, tool_calls, usage}` and streams `data: {"response": ...}` events.
// `openai` is an OpenAI chat completion with `choices` and streams
// `chat.completion.chunk` events.
export type AiResponseShape = "legacy" | "openai";

export interface AiModelMapping {
	model: string;
	shape: AiResponseShape;
	task: AiModelTask;
}

export const aiModelsVariable = "ORANGE_AI_MODELS";

// Seeded from the models that surveyed Workers use most. Each provider ID was
// found in OpenRouter's public model lists (`GET /api/v1/models` and
// `GET /api/v1/embeddings/models`) on 2026-10-20. An embedding model maps only
// to the same model, so vectors stay compatible with stored data. OpenRouter
// does not serve `@cf/baai/bge-small-en-v1.5`, so it has no mapping.
//
// Response shapes follow workerd's model types. Llama 3.3 returns
// `{response, ...}`. GLM 4.7 Flash and Kimi K2.7 Code return
// `ChatCompletionsOutput`, and gpt-oss returns it for `messages` input.
// https://github.com/cloudflare/workerd/blob/b73ce3ae105c35bafaaad864095079524573a465/types/defines/ai.d.ts#L640-L650
// https://github.com/cloudflare/workerd/blob/b73ce3ae105c35bafaaad864095079524573a465/types/defines/ai.d.ts#L2136-L2141
// https://github.com/cloudflare/workerd/blob/b73ce3ae105c35bafaaad864095079524573a465/types/defines/ai.d.ts#L4732-L4739
// https://github.com/cloudflare/workerd/blob/b73ce3ae105c35bafaaad864095079524573a465/types/defines/ai.d.ts#L5818-L5841
export const builtInAiModels: Readonly<Record<string, AiModelMapping>> = {
	"@cf/baai/bge-base-en-v1.5": embeddings("baai/bge-base-en-v1.5"),
	"@cf/baai/bge-large-en-v1.5": embeddings("baai/bge-large-en-v1.5"),
	"@cf/baai/bge-m3": embeddings("baai/bge-m3"),
	"@cf/meta/llama-3.1-8b-instruct": text("meta-llama/llama-3.1-8b-instruct", "legacy"),
	"@cf/meta/llama-3.1-8b-instruct-fast": text("meta-llama/llama-3.1-8b-instruct", "legacy"),
	"@cf/meta/llama-3.3-70b-instruct-fp8-fast": text("meta-llama/llama-3.3-70b-instruct", "legacy"),
	"@cf/moonshotai/kimi-k2.7-code": text("moonshotai/kimi-k2.7-code", "openai"),
	"@cf/openai/gpt-oss-120b": text("openai/gpt-oss-120b", "openai"),
	"@cf/openai/gpt-oss-20b": text("openai/gpt-oss-20b", "openai"),
	"@cf/zai-org/glm-4.7-flash": text("z-ai/glm-4.7-flash", "openai"),
};

function text(model: string, shape: AiResponseShape): AiModelMapping {
	return { model, shape, task: "text" };
}

function embeddings(model: string): AiModelMapping {
	return { model, shape: "legacy", task: "embeddings" };
}

// Parses `ORANGE_AI_MODELS`, for example
// `{"@cf/meta/llama-3-8b-instruct": {"model": "meta-llama/llama-3-8b-instruct", "task": "text"}}`,
// and merges it over the built-in table. `shape` defaults to `legacy`.
export function resolveAiModels(
	overrides: string | undefined,
): Map<string, AiModelMapping> {
	const models = new Map(Object.entries(builtInAiModels));
	if (overrides === undefined || overrides.trim().length === 0) return models;
	let parsed: unknown;
	try {
		parsed = JSON.parse(overrides);
	} catch (error: unknown) {
		throw new Error(
			`${aiModelsVariable} is not valid JSON: ${errorMessage(error)}`,
		);
	}
	if (!isRecord(parsed)) {
		throw new Error(
			`${aiModelsVariable} must be a JSON object that maps Workers AI model names to {"model", "task"}.`,
		);
	}
	for (const [name, mapping] of Object.entries(parsed)) {
		if (
			!isRecord(mapping) ||
			typeof mapping.model !== "string" ||
			mapping.model.length === 0 ||
			(mapping.task !== "text" && mapping.task !== "embeddings") ||
			(mapping.shape !== undefined && mapping.shape !== "legacy" && mapping.shape !== "openai")
		) {
			throw new Error(
				`${aiModelsVariable} entry ${JSON.stringify(name)} must be {"model": "<provider model>", "task": "text" | "embeddings", "shape"?: "legacy" | "openai"}.`,
			);
		}
		models.set(name, {
			model: mapping.model,
			shape: mapping.shape ?? "legacy",
			task: mapping.task,
		});
	}
	return models;
}
