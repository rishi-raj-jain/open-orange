# Workers KV

Create, read, list, and delete notes in a KV namespace.

## What it shows

- `put()` with an optional `expirationTtl`. KV rejects a TTL under 60 seconds,
  as it does on Cloudflare.
- `get()`, `delete()`, and `list({ prefix })`.

## Run it

From this directory:

```sh
pnpm open-orange dev     # or: pnpm wrangler dev --port 8788
```

## Try it

```sh
curl -X PUT localhost:8787/notes/todo-1 -d 'buy milk'
curl -X PUT 'localhost:8787/notes/todo-2?ttl=120' -d 'call home'
curl localhost:8787/notes/todo-1
curl 'localhost:8787/notes?prefix=todo-'   # todo-2 has an expiration
curl -X DELETE localhost:8787/notes/todo-1
curl -X PUT 'localhost:8787/notes/todo-3?ttl=30' -d 'soon'   # 400
```

## Restarts

Notes persist across `open-orange dev` restarts.
