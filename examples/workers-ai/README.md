# Workers AI

A small assistant API on the Workers AI binding. It chats, streams, calls a
tool, ranks documents with embeddings, and reads raw provider responses. It is
plain Cloudflare code with no OpenOrange imports.

## What it shows

- `env.AI.run()` with chat `messages`, `max_tokens`, and `temperature`, and
  the `{ response, usage }` result.
- `stream: true`: the Worker returns the model's Server-Sent Events stream
  (`data: {"response":"..."}` events, then `data: [DONE]`).
- Tool calling: the model returns `tool_calls`, the Worker runs the tool, and
  the model answers with the tool's result.
- Embeddings with `@cf/baai/bge-base-en-v1.5`: the `{ shape, data }` result,
  used to rank documents by cosine similarity.
- An `openai`-shape model, `@cf/openai/gpt-oss-20b`, that returns a chat
  completion with `choices` instead of `{ response }`.
- `returnRawResponse: true`: `run()` returns the HTTP response and never
  throws, so the Worker checks the status itself.
- `env.AI.models()` to search the available models.
- A provider error reaches the Worker as an `InferenceUpstreamError`. The
  Worker returns it as a 502 with the provider's message. Bad input is a 400.

## Choose a model provider

OpenOrange sends each call to an OpenAI-compatible provider. Put the settings
in `.dev.vars` in this directory, or in the shell environment.

| Variable | Use |
|---|---|
| `OPENROUTER_API_KEY` | The key for OpenRouter, the default provider |
| `ORANGE_AI_API_KEY` | The key for any provider. It wins over `OPENROUTER_API_KEY` |
| `ORANGE_AI_BASE_URL` | An OpenAI-compatible API, for example a local server. No key is needed |
| `ORANGE_AI_MODELS` | JSON that maps Workers AI model names to provider models |

OpenRouter, the default:

```dotenv
OPENROUTER_API_KEY=sk-or-...
```

A local [Ollama](https://ollama.com) server, with no key. Map each Workers AI
model this example uses to a model that Ollama has pulled:

```dotenv
ORANGE_AI_BASE_URL=http://127.0.0.1:11434/v1
ORANGE_AI_MODELS={"@cf/meta/llama-3.1-8b-instruct":{"model":"llama3.1:8b","task":"text"},"@cf/openai/gpt-oss-20b":{"model":"gpt-oss:20b","task":"text","shape":"openai"},"@cf/baai/bge-base-en-v1.5":{"model":"nomic-embed-text","task":"embeddings"}}
```

Each `ORANGE_AI_MODELS` entry is `{"model", "task": "text" | "embeddings",
"shape"?: "legacy" | "openai"}`. `shape` picks the result: `legacy` is
`{ response, tool_calls, usage }`, `openai` is a chat completion. Entries
merge over OpenOrange's built-in table, so you only list the models you change.

`wrangler dev` always calls Cloudflare's Workers AI and needs a Cloudflare
login.

## Run it

From this directory:

```sh
pnpm open-orange dev     # or: pnpm wrangler dev --port 8788
```

## Try it

```sh
# Chat
curl localhost:8787/chat -H 'content-type: application/json' \
  -d '{"messages":[{"role":"user","content":"What is a Durable Object?"}]}'

# Stream the answer as Server-Sent Events
curl -N localhost:8787/chat -H 'content-type: application/json' \
  -d '{"stream":true,"messages":[{"role":"user","content":"Count to five"}]}'

# Tool calling
curl localhost:8787/ask -H 'content-type: application/json' \
  -d '{"question":"What is the weather in Lisbon?"}'

# Rank documents with embeddings
curl localhost:8787/search -H 'content-type: application/json' \
  -d '{"query":"storage","documents":["KV stores values","Queues send messages"]}'

# An OpenAI-shape model
curl localhost:8787/openai -H 'content-type: application/json' \
  -d '{"messages":[{"role":"user","content":"Say hi"}]}'

# The raw provider response, with its status in x-provider-status
curl -i localhost:8787/raw -d 'Say hi'

# Search the models
curl 'localhost:8787/models?search=llama'

# A 400: no messages
curl localhost:8787/chat -H 'content-type: application/json' -d '{}'
```

Without a provider key or base URL, every model call returns a 502 that names
the variables to set. `/raw` returns the 401 itself.

## In the open-orange dev output

`open-orange dev` logs each model call with the Workers AI model, the provider
model, the status, and the duration, for example
`@cf/meta/llama-3.1-8b-instruct -> llama3.1:8b 200 412ms`. Workers AI uses no
Rivet Actors.

## Differences from Cloudflare

- `env.AI.gateway()`, `autorag()`, `aiSearch()`, and `toMarkdown()` throw a
  not-supported error. The `gateway` option of `run()` is accepted and ignored.
- Responses API input (`input`) is not supported yet. Use `messages`.
