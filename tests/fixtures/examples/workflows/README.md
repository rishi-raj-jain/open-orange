# Workflows

An order Workflow: reserve stock, charge a card with retries, wait for a
dispatch window, wait for a manager's decision, then ship or refund.

## What it shows

- A `WorkflowEntrypoint` class and every `WorkflowStep` method:
  - `step.do()` with a `retries` config (`limit`, `delay`, `backoff`) and a
    `timeout`. The callback reads `ctx.attempt`.
  - `NonRetryableError` from `cloudflare:workflows`, which stops a step and the
    instance at once, with no retries.
  - `step.sleep()` with a duration string, and `step.sleepUntil()` with a time
    picked inside a step so a replay sees the same value.
  - `step.waitForEvent()` with a `timeout`, and catching the timeout to cancel
    and refund.
- The binding: `create()` with a custom id, with a random id, with a taken id
  (`instance.already_exists`), and with an invalid id; `createBatch()`; `get()`
  on a missing id.
- The instance: `status()` with `output` or `error`, `sendEvent()` before the
  instance waits, and `pause()`, `resume()`, `terminate()`, and `restart()`.

## Run it

From this directory:

```sh
pnpm open-orange dev     # or: pnpm wrangler dev --port 8788
```

## Try it

```sh
# An order whose card fails twice, then works on attempt 3.
curl -X POST localhost:8787/orders -d '{"id":"order-1","item":"book","quantity":2,"card":"flaky"}'
curl localhost:8787/orders/order-1                   # "running", then "waiting"
curl -X POST 'localhost:8787/orders/order-1/approve?by=ada'
curl localhost:8787/orders/order-1                   # "complete": charge.attempts is 3

# A batch: one order to reject, one that nobody answers within 2 seconds.
curl -X POST localhost:8787/orders/batch -d '[{"id":"order-2","item":"lamp","quantity":1},{"id":"order-3","item":"book","quantity":1,"approvalTimeout":"2 seconds"}]'
curl -X POST 'localhost:8787/orders/order-2/reject?by=grace'
curl localhost:8787/orders/order-2                   # "rejected by grace", refunded
curl localhost:8787/orders/order-3                   # after ~4 s: "cancelled: no decision in time"

# Failures that a retry cannot fix: the instance is "errored".
curl -X POST localhost:8787/orders -d '{"id":"order-4","item":"lamp","quantity":5}'
curl -X POST localhost:8787/orders -d '{"id":"order-5","item":"book","quantity":1,"card":"declined"}'
curl localhost:8787/orders/order-4                   # error: NonRetryableError "Only 2 lamp in stock"

# Create errors.
curl -X POST localhost:8787/orders -d '{"id":"order-1","item":"book","quantity":1}'   # 409 instance.already_exists
curl -X POST localhost:8787/orders -d '{"id":"bad id!","item":"book","quantity":1}'   # 400 invalid id
curl -X POST localhost:8787/orders -d '{"item":"book","quantity":1}'                  # 201, random UUID

# Lifecycle controls. A call that does not fit the status fails with 409.
curl -X POST localhost:8787/orders/order-1/pause     # also resume, terminate, restart
curl localhost:8787/orders/missing                   # 404
```

## Restarts

A waiting instance continues after an `open-orange dev` restart.

## Differences from Cloudflare

Orange runs Cloudflare's own Workflows engine, the one `wrangler dev` runs. See
[the Workflows module](../../docs/modules/workflows.mdx) for the differences
that remain, such as the 2 MiB value limit.
