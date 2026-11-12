// A small assistant API on the Workers AI binding: chat, streaming, tool
// calling, embeddings, an OpenAI-shaped model, and raw provider responses.

interface Env {
	AI: Ai;
}

// `{response, tool_calls, usage}` results and `data: {"response"}` stream events.
const chatModel = "@cf/meta/llama-3.1-8b-instruct";
// An OpenAI chat completion with `choices`.
const openAiModel = "@cf/openai/gpt-oss-20b";
const embeddingModel = "@cf/baai/bge-base-en-v1.5";

type Message = {
	role: "system" | "user" | "assistant" | "tool";
	content: string;
	tool_call_id?: string;
	name?: string;
};
type ToolCall = { id: string; name: string; arguments: Record<string, unknown> };

const tools = [
	{
		name: "get_weather",
		description: "Get the current weather for a city.",
		parameters: {
			type: "object",
			properties: { city: { type: "string", description: "The city name" } },
			required: ["city"],
		},
	},
];

// The tool the model may call. A real app would call a weather API here.
function getWeather({ city }: Record<string, unknown>): string {
	return JSON.stringify({ city, forecast: "sunny", celsius: 24 });
}

class BadRequest extends Error {}

async function body(request: Request): Promise<Record<string, unknown>> {
	try {
		const value: unknown = await request.json();
		if (typeof value === "object" && value !== null && !Array.isArray(value)) {
			return value as Record<string, unknown>;
		}
	} catch {}
	throw new BadRequest("Send a JSON object");
}

function messagesFrom(input: Record<string, unknown>): Message[] {
	const { messages } = input;
	if (
		!Array.isArray(messages) ||
		messages.length === 0 ||
		!messages.every((m) => typeof m?.role === "string" && typeof m?.content === "string")
	) {
		throw new BadRequest('Send {"messages":[{"role":"user","content":"..."}]}');
	}
	return messages as Message[];
}

function cosine(left: number[], right: number[]): number {
	let dot = 0;
	let leftNorm = 0;
	let rightNorm = 0;
	for (let i = 0; i < left.length; i++) {
		dot += left[i]! * right[i]!;
		leftNorm += left[i]! ** 2;
		rightNorm += right[i]! ** 2;
	}
	return dot / Math.sqrt(leftNorm * rightNorm);
}

async function chat(request: Request, env: Env): Promise<Response> {
	const input = await body(request);
	const messages = messagesFrom(input);
	if (input.stream === true) {
		// With `stream: true`, run() resolves to a Server-Sent Events stream
		// once the provider accepts the request. A provider error still throws here.
		const stream = (await env.AI.run(chatModel, {
			messages,
			stream: true,
		})) as unknown as ReadableStream;
		return new Response(stream, { headers: { "content-type": "text/event-stream" } });
	}
	const { response, usage } = (await env.AI.run(chatModel, {
		messages,
		max_tokens: 256,
		temperature: 0.2,
	})) as { response?: string; usage?: unknown };
	return Response.json({ answer: response, usage });
}

// One round of tool calling: the model asks for a tool, the Worker runs it,
// and the model answers with the tool's result.
async function ask(request: Request, env: Env): Promise<Response> {
	const { question } = await body(request);
	if (typeof question !== "string" || question.length === 0) {
		throw new BadRequest('Send {"question":"..."}');
	}
	const messages: Message[] = [
		{ role: "system", content: "Use the tools when they help." },
		{ role: "user", content: question },
	];
	const first = (await env.AI.run(chatModel, { messages, tools })) as {
		response?: string;
		tool_calls?: ToolCall[];
	};
	const calls = first.tool_calls ?? [];
	if (calls.length === 0) return Response.json({ answer: first.response, toolCalls: [] });

	for (const call of calls) {
		if (call.name !== "get_weather") {
			return Response.json({ error: `The model called an unknown tool: ${call.name}` }, { status: 502 });
		}
		messages.push({
			role: "tool",
			tool_call_id: call.id,
			name: call.name,
			content: getWeather(call.arguments),
		});
	}
	const final = (await env.AI.run(chatModel, { messages })) as { response?: string };
	return Response.json({
		answer: final.response,
		toolCalls: calls.map(({ name, arguments: args }) => ({ name, arguments: args })),
	});
}

// Embeds a query and documents, then ranks the documents by cosine similarity.
async function search(request: Request, env: Env): Promise<Response> {
	const { query, documents } = await body(request);
	if (
		typeof query !== "string" ||
		!Array.isArray(documents) ||
		documents.length === 0 ||
		!documents.every((d) => typeof d === "string")
	) {
		throw new BadRequest('Send {"query":"...","documents":["...","..."]}');
	}
	const { data, shape } = (await env.AI.run(embeddingModel, {
		text: [query, ...documents],
	})) as { data: number[][]; shape: number[] };
	const [queryVector, ...documentVectors] = data;
	const ranked = documents
		.map((text, i) => ({ text, score: cosine(queryVector!, documentVectors[i]!) }))
		.sort((left, right) => right.score - left.score);
	return Response.json({ shape, ranked });
}

// gpt-oss returns OpenAI's chat completion shape, not `{response}`.
async function openAi(request: Request, env: Env): Promise<Response> {
	const messages = messagesFrom(await body(request));
	const completion = (await env.AI.run(openAiModel, {
		messages: messages as ChatCompletionMessageParam[],
	})) as {
		model?: string;
		choices?: { message?: { content?: string } }[];
	};
	return Response.json({
		answer: completion.choices?.[0]?.message?.content,
		model: completion.model,
	});
}

// With `returnRawResponse`, run() returns the provider's HTTP response as is.
// It never throws for a provider error, so the Worker checks the status itself.
async function raw(request: Request, env: Env): Promise<Response> {
	const prompt = await request.text();
	const response = (await env.AI.run(
		chatModel,
		{ prompt },
		{ returnRawResponse: true },
	)) as unknown as Response;
	return new Response(response.body, {
		status: response.status,
		headers: {
			"content-type": response.headers.get("content-type") ?? "application/json",
			"x-provider-status": String(response.status),
		},
	});
}

async function route(request: Request, env: Env): Promise<Response> {
	const { pathname, searchParams } = new URL(request.url);
	const key = `${request.method} ${pathname}`;
	switch (key) {
		case "POST /chat":
			return chat(request, env);
		case "POST /ask":
			return ask(request, env);
		case "POST /search":
			return search(request, env);
		case "POST /openai":
			return openAi(request, env);
		case "POST /raw":
			return raw(request, env);
		case "GET /models": {
			const search = searchParams.get("search") ?? undefined;
			const models = (await env.AI.models(search ? { search } : {})) as { name: string }[];
			return Response.json({ models: models.map(({ name }) => name) });
		}
		default:
			return Response.json(
				{ routes: ["POST /chat", "POST /ask", "POST /search", "POST /openai", "POST /raw", "GET /models"] },
				{ status: 404 },
			);
	}
}

export default {
	async fetch(request, env): Promise<Response> {
		try {
			return await route(request, env);
		} catch (error) {
			if (error instanceof BadRequest) {
				return Response.json({ error: error.message }, { status: 400 });
			}
			// The model provider failed or rejected the call. On Cloudflare and on
			// OpenOrange this is an `InferenceUpstreamError` with the provider's message.
			const name = error instanceof Error ? error.name : "Error";
			const message = error instanceof Error ? error.message : String(error);
			return Response.json({ error: message, name }, { status: 502 });
		}
	},
} satisfies ExportedHandler<Env>;
