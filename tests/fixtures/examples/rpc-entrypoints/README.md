# RPC with entrypoints and RpcTarget

Workers RPC three ways: a named entrypoint, a service binding, and a Durable
Object that returns an object by reference.

## What it shows

- `Greeter extends WorkerEntrypoint` is a named entrypoint.
- The `GREETER` service binding points at this Worker's own `Greeter`, so
  `env.GREETER.greet()` is an RPC call.
- `Counter.tally()` returns a `Tally`, which extends `RpcTarget`. The Worker
  gets a stub, and each call on it runs inside the Durable Object.
- An error thrown in the Durable Object reaches the caller with its message.

## Run it

From this directory:

```sh
pnpm open-orange dev     # or: pnpm wrangler dev --port 8788
```

## Try it

```sh
curl 'localhost:8787/greet?name=Ada'                  # Hello, Ada!
curl -X POST 'localhost:8787/counters/a?amount=2'     # {"total":2}
curl localhost:8787/counters/a                        # {"total":2}
curl -X POST 'localhost:8787/counters/a?amount=-1'    # 400 {"error":"amount must be a positive integer"}
```
