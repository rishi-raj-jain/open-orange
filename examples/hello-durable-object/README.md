# Hello Durable Object

The simplest Durable Object: one SQLite database per name, called over RPC.

Adapted from Cloudflare's
[`hello-world-do-template`](https://github.com/cloudflare/templates/tree/dfdf14099a81a08cfe1ffc78f8463605670ae513/hello-world-do-template)
(MIT License, Copyright (c) 2018, Cloudflare, Inc.).

## What it shows

- `getByName()` sends every request for one name to one `Greeter` object.
- `ctx.storage.sql` keeps a visit count in that object's own SQLite database.
- The Worker calls `sayHello()` on the stub like a local method.

## Run it

From this directory:

```sh
pnpm open-orange dev     # or: pnpm wrangler dev --port 8788
```

## Try it

```sh
curl localhost:8787/alice   # {"greeting":"Hello, alice!","visits":1}
curl localhost:8787/alice   # "visits":2
curl localhost:8787/bob     # "visits":1, because bob is a different object
```

Stop `open-orange dev` with Ctrl-C and start it again. `alice` continues from 3.
