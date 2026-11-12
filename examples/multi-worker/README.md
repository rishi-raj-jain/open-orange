# Multiple Workers

Three Workers in one `open-orange dev` session. `gateway` serves HTTP and owns
no state. `auth` owns users and sessions. `jobs` owns the email queue consumer
and the signup Workflow.

## What each Worker owns

| Worker | Config | Owns | Uses from other Workers |
|---|---|---|---|
| `gateway` (primary) | `wrangler.jsonc` | Nothing. It serves the port. | `AUTH` and `ADMIN` services, `SESSIONS` Durable Object, `EMAILS` queue producer, `SIGNUPS` Workflow, `WORKERS` dispatch namespace |
| `auth` | `auth/wrangler.jsonc` | `Session` Durable Object, `USERS` KV | Nothing |
| `jobs` | `jobs/wrangler.jsonc` | `emails` and `emails-failed` consumers, `SignupWorkflow`, `OUTBOX` KV | Nothing |

## What it shows

- A service binding with `fetch()` and JS RPC to a default `WorkerEntrypoint`.
- A service binding to a named entrypoint (`"entrypoint": "Admin"`).
- An error thrown in `auth` reaches `gateway` over RPC with its message.
- A Durable Object binding with `script_name`. The object runs in `auth`,
  which exports the class. `gateway` and `auth` see the same state.
- A queue that `gateway` produces to and `jobs` consumes, with `retry()`,
  `max_retries`, and a dead letter queue.
- A Workflow binding with `script_name`. `gateway` creates and reads
  instances; they run in `jobs`. A second instance with the same id fails.
- A Workflow step that sends to a queue.
- A dispatch namespace. `env.WORKERS.get(name)` returns the session Worker with
  that name. An unknown name throws `Worker not found.`

## Run it

From this directory, pass one `-c` per Worker. The first one is the primary
Worker, which serves the port:

```sh
pnpm open-orange dev -c wrangler.jsonc -c auth/wrangler.jsonc -c jobs/wrangler.jsonc
# or: pnpm wrangler dev --port 8788 -c wrangler.jsonc -c auth/wrangler.jsonc -c jobs/wrangler.jsonc
```

Every Worker must set `name`. Bindings find other Workers by that name. If you
leave out a Worker, calls to it fail with
`Worker "<name>" not found. Make sure it is running locally.`

## Try it

```sh
curl localhost:8787/health                      # auth is up (service fetch)
curl localhost:8787/login/ada                   # {"logins":1,"user":"ada"} (RPC)
curl localhost:8787/login/Ada%21                # 400, the RangeError from auth
curl localhost:8787/sessions/ada                # {"active":true,"logins":1} (script_name)
curl localhost:8787/stats                       # {"users":["ada"]} (named entrypoint)
curl -X DELETE localhost:8787/sessions/ada      # {"revoked":"ada"}

curl -X POST localhost:8787/emails -d '{"to":"ada@example.com"}'     # 202, sent by jobs
curl -X POST localhost:8787/emails -d '{"to":"x@bounce.test"}'       # 202, bounces to emails-failed
curl -X POST localhost:8787/emails -d '{}'                           # 400

curl -X POST localhost:8787/signups/bob -d '{"email":"bob@example.com"}'   # 201
curl -X POST localhost:8787/signups/bob -d '{"email":"bob@example.com"}'   # 409, id exists
curl localhost:8787/signups/bob                 # {"output":{...},"status":"complete"}
curl localhost:8787/signups/nobody              # 404

curl localhost:8787/workers/jobs/emails         # jobs' fetch(), through the dispatch namespace
curl localhost:8787/workers/billing/            # 404, Worker not found.
```

## State

All three Workers use one Rivet Engine, and keep their data in the primary
Worker's `.open-orange/` directory.
