# Chat with hibernation

A chat room that sleeps between messages while its WebSocket clients stay
connected.

Inspired by Cloudflare's
[`durable-chat-template`](https://github.com/cloudflare/templates/tree/dfdf14099a81a08cfe1ffc78f8463605670ae513/durable-chat-template),
rewritten without PartyServer.

## What it shows

- `ctx.acceptWebSocket()` registers hibernatable WebSockets. The room can
  sleep without closing them.
- Tags: each socket is tagged with its user name, so
  `ctx.getWebSockets("bob")` finds bob after the room wakes up.
- `setWebSocketAutoResponse()` answers `ping` with `pong`.
- SQLite keeps the message history. New members receive it when they join.

## Run it

From this directory:

```sh
pnpm open-orange dev     # or: pnpm wrangler dev --port 8788
```

## Try it

Connect two clients to the same room, for example with
[`wscat`](https://www.npmjs.com/package/wscat):

```sh
npx wscat -c 'ws://localhost:8787/rooms/lobby?user=alice'
npx wscat -c 'ws://localhost:8787/rooms/lobby?user=bob'
```

Then send these messages:

| Send | Result |
|---|---|
| `{"text":"hello"}` | Everyone in the room gets the message. |
| `{"to":"bob","text":"psst"}` | Only bob gets the message. |
| `{"to":"carol","text":"hi"}` | You get an error: `carol is not in this room`. |
| `ping` | You get `pong`. |

A request without `Upgrade: websocket` gets 426. A missing `?user=` gets 400.
