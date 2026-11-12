# Collaborative counter

A counter that every connected client can change and watch live.

## What it shows

- Standard WebSockets with `server.accept()`. Unlike
  [chat-hibernation](../chat-hibernation), the object stays in memory while a
  client is connected.
- Broadcast: every change goes to every connected client, in order.
- `ctx.storage.kv` is synchronous in SQLite-backed objects. Each update is
  stored and broadcast in one step, so clients see every value in order.

## Run it

From this directory:

```sh
pnpm open-orange dev     # or: pnpm wrangler dev --port 8788
```

## Try it

Open two clients, for example with
[`wscat`](https://www.npmjs.com/package/wscat):

```sh
npx wscat -c ws://localhost:8787/counters/shared
```

Each client first gets `{"value":0}`. Send `increment` or `decrement` from
either client, and both get the new value. Any other message gets an error,
for example `{"error":"Unknown command: reset"}`, and only the sender sees it.
