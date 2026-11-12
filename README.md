<h1 align="center">
  <a href="https://openorange.dev">
    <picture>
      <source media="(prefers-color-scheme: dark)" srcset="docs/images/readme-logo-dark.svg">
      <img src="docs/images/readme-logo.svg" width="350" height="72" alt="OpenOrange">
    </picture>
  </a>
</h1>

<p align="center"><strong>Run Cloudflare Workers anywhere: AWS, Google Cloud, Azure or your own servers.</strong></p>

<p align="center">
  <a href="https://openorange.dev/docs/">Docs</a> ·
  <a href="https://openorange.dev/docs/deploy/">Deploy</a> ·
  <a href="https://openorange.dev/docs/migrate/">Migrate</a> ·
  <a href="https://openorange.dev/docs/bindings/">Bindings</a> ·
  <a href="examples/">Examples</a> ·
  <a href="https://rivet.dev/discord">Discord</a>
</p>

## What is OpenOrange

OpenOrange runs your existing Cloudflare Workers project on AWS, Google Cloud, Azure or your own servers, with no changes to your code. `wrangler dev` becomes `orange dev`, your `wrangler.jsonc` stays the source of truth, and everything underneath is open source and self-hostable.

## Why OpenOrange

| | Cloudflare | OpenOrange |
|---|---|---|
| [Durable Object compute](https://openorange.dev/#cost) | $0.045 per GB-hour | **4.8× cheaper**: $0.0094 on Graviton, with 40% headroom |
| [Durable Object storage](https://openorange.dev/#cost) | $0.20 per GB-month | **8.7× cheaper**: $0.023, S3 in your account |
| [SQLite writes](https://openorange.dev/#cost) | $1.00 per million rows | **About 5.7× cheaper**: about $0.18, measured on Rivet |
| [Runtime limits](#limits) | 128 MB memory, 5 min CPU, 15 min background jobs | No platform caps: your machine sets them |
| [Moving off](https://openorange.dev/docs/migrate/) | Your data stays on Cloudflare | Live migration: Durable Objects move with zero downtime |
| [Where it runs](https://openorange.dev/docs/deploy/) | Cloudflare's network | Rivet Cloud on AWS or Google Cloud, your own cloud account (BYOC), your servers, or air-gapped |
| [Latency to your database](https://openorange.dev/vs-durable-objects/) | Every query crosses the internet | In your VPC, next to your database |

## How it works

<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="docs/images/hero-dark.svg">
    <img src="docs/images/hero.svg" width="560" alt="A Cloudflare Worker and its bindings run on Rivet Actors">
  </picture>
</p>

- **Each Worker runs as a Node.js process.** OpenOrange implements the Workers API on stock Node.js and reads your Wrangler configuration as it is.
- **Each Durable Object is a [Rivet Actor](https://rivet.dev/actors/docs/)** with its own SQLite database, stored in S3. KV, D1, Queues, Workflows and Cron Triggers run on Rivet Actors too.
- **`orange deploy` ships a standard Docker image.** It runs on Rivet Cloud, in your own cloud account, or anywhere Docker runs, and connects out to the Rivet control plane, which places Actors across your machines.

See [Architecture](https://openorange.dev/docs/architecture/).

## Use a coding agent

Paste this into your coding agent (Claude Code, Codex, Cursor, …) from your Worker project:

```text
Move this Cloudflare Worker to Rivet with OpenOrange.

1. Install the CLI with `pnpm add -g open-orange`, run `orange doctor` here,
   and show me what needs setup.
2. Read https://github.com/rivet-dev/open-orange/blob/main/skills/rivet-open-orange/SKILL.md
   and follow it. Ask me before each step that deploys or moves data.
```

## What runs where

| Cloudflare binding | Status | Runs on |
|---|---|---|
| [Durable Objects](https://openorange.dev/docs/bindings/durable-objects/) | Partial | One Rivet Actor for each object, with its own SQLite database |
| [KV](https://openorange.dev/docs/bindings/kv/), [D1](https://openorange.dev/docs/bindings/d1/), [Rate Limiting](https://openorange.dev/docs/bindings/rate-limiting/) | Drop-in | Rivet Actors |
| [Cache](https://openorange.dev/docs/bindings/cache/) | Partial | One Rivet Actor for each cache name |
| [Queues](https://openorange.dev/docs/bindings/queues/) | Drop-in | One Rivet Actor for each queue |
| [Workflows](https://openorange.dev/docs/bindings/workflows/) | Partial | Cloudflare's own Workflows engine, with one Rivet Actor for each instance |
| [Cron Triggers](https://openorange.dev/docs/bindings/cron-triggers/) | Drop-in | A Rivet Actor |
| [Tail Workers](https://openorange.dev/docs/bindings/tail-workers/) | Partial | Rivet Durable Streams |
| [R2](https://openorange.dev/docs/bindings/r2/) | Pluggable | A Rivet Actor, or Amazon S3, Google Cloud Storage, Cloudflare R2 or MinIO |
| [Worker Loader](https://openorange.dev/docs/bindings/worker-loader/) | Partial | A separate process in an agentOS VM |
| [Workers AI](https://openorange.dev/docs/bindings/workers-ai/) | Pluggable | OpenRouter, OpenAI, or any OpenAI-compatible endpoint |
| [Send Email](https://openorange.dev/docs/bindings/email/) | Pluggable | Amazon SES, or any SMTP server |
| [Browser Rendering](https://openorange.dev/docs/bindings/browser-rendering/) | Pluggable | Browserbase, or any Chrome DevTools endpoint |
| [Hyperdrive](https://openorange.dev/docs/bindings/hyperdrive/) | Drop-in | Your Postgres or MySQL database, with a direct connection |
| [Sandbox](https://openorange.dev/docs/bindings/sandbox/) | Pluggable | E2B, Daytona, Freestyle, agentOS, or a local directory |
| Analytics Engine | Not supported | `writeDataPoint()` drops each data point |
| Vectorize, Images, Media, Stream, Pipelines, AI Search, mTLS certificates, VPC, and legacy blobs | Not supported | Calls throw |

**Drop-in** runs as on Cloudflare. **Pluggable** runs on a provider you configure. **Partial** runs with known differences, listed on each binding's page. See [binding configuration](https://openorange.dev/docs/bindings/configuration/) for every Wrangler key and the variables each provider needs, and [Compatibility](https://openorange.dev/docs/compatibility/) for the test results.

## Limits

| Limit | Cloudflare Workers Paid | OpenOrange |
|---|---|---|
| Memory per Worker or Durable Object | 128 MB | Up to your machine's memory. The Node.js heap is up to about 4 GB by default, and configurable. |
| CPU time per request | 30 s default, 5 min max | No cap |
| Cron, queue and alarm handlers | 15 min wall time | No cap |
| Open connections per request | 6 at once | OS limits |
| Storage per Durable Object | 10 GB | No cap |
| Worker bundle | 64 MiB | No cap |
| Node.js | `nodejs_compat` subset | Stock Node.js |

Cloudflare values are from its [limits docs](https://developers.cloudflare.com/workers/platform/limits/). Rivet's own limits are mostly soft limits you can raise: see [Limits](https://openorange.dev/docs/operations/limits/).

## Quickstart

You need a Worker project with a `wrangler.jsonc`, `wrangler.json`, or `wrangler.toml` (or use [`examples/hello-durable-object`](examples/hello-durable-object)), Node.js 22 or later, pnpm, and Docker to deploy.

### Step 1: Install

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/images/step-1-install-dark.svg">
  <img alt="OpenOrange reads the wrangler.jsonc and source files that your Worker already has" src="docs/images/step-1-install.svg">
</picture>

```sh
pnpm add -g open-orange
```

Your code and your Wrangler configuration do not change.

### Step 2: Check your Worker

Run this in your Worker project:

```sh
orange doctor
```

It lists each binding as **runs as is**, **needs a service you supply** (with the variable to set), or **not supported**, says which Durable Object classes `orange migrate` can move, and ends with the commands to run next. Add `--json` for a coding agent.

### Step 3: Run your Worker

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/images/step-2-dev-dark.svg">
  <img alt="orange dev serves your Worker on localhost, and each Durable Object runs as a Rivet Actor with its own SQLite database" src="docs/images/step-2-dev.svg">
</picture>

```sh
orange dev
```

For a Worker with one Durable Object binding, it prints:

```text
  Binding       Resource         Runs on
  env.COUNTER   Durable Object   Rivet Actor · Counter

● Ready in 4.6s
  Local         http://127.0.0.1:8787
  Agent         Run orange mcp to connect your coding agent to the Rivet MCP
```

The `Agent` row shows until an agent configuration has the Rivet MCP.

Your Worker now answers on `http://localhost:8787`. Its data is in `.open-orange/` and stays there when you restart. Add `.open-orange/` to your `.gitignore`.

### Step 4: Deploy

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/images/step-3-deploy-dark.svg">
  <img alt="orange deploy builds an image of your Worker, uploads it, and rolls a runner pool out to it on a Rivet cluster" src="docs/images/step-3-deploy.svg">
</picture>

```sh
orange login
orange link --cluster <cluster-name>
orange deploy
```

The command prints the public URL of the runner pool. Your Worker now serves from your Rivet cluster.

Pass variables and secrets with flags:

| Flag | Does |
|---|---|
| `--var NAME:value` | Sets a variable. Replaces a `vars` entry of the same name. |
| `--secret KEY` | Sets `env.KEY` to a secret that the cluster already holds |
| `--secrets-file .dev.vars` | Rolls out each entry of a JSON or `.env` file as a cluster secret |

```sh
orange deploy --secrets-file .dev.vars --var LOG_LEVEL:debug
```

> [!TIP]
> `orange deploy --dry-run` writes the build and prints the plan. It calls no API.

See the [deploy guide](https://openorange.dev/docs/deploy/) for every flag, rollback, CI tokens, and self-hosting the control plane.

### Self-host

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/images/self-host-dark.svg">
  <img alt="On your own server, orange serve runs your Worker and connects out to your Rivet Engine" src="docs/images/self-host.svg">
</picture>

`orange serve` runs your Worker against the Rivet Engine in `RIVET_ENDPOINT`. It connects out to the Engine, so the Engine does not need to reach your server.

```sh
RIVET_ENDPOINT=https://<namespace>:<token>@<engine-host> orange serve
```

To run it as a container, write the image that `orange deploy` builds:

```sh
orange deploy --dry-run --outdir out
docker build --platform linux/amd64 -f out/Dockerfile -t my-worker out/context
docker run --rm -p 8080:8080 -e RIVET_ENDPOINT=https://<namespace>:<token>@<engine-host> my-worker
```

## Add the Rivet MCP

Add the Rivet MCP to your agent, then approve the Rivet sign-in.

**Claude Code**

```sh
claude mcp add --transport http rivet "https://mcp.rivet.dev/mcp"
```

**Codex**

```sh
codex mcp add rivet --url https://mcp.rivet.dev/mcp
```

**Cursor** (add to your MCP configuration)

```json
{ "mcpServers": { "rivet": { "url": "https://mcp.rivet.dev/mcp" } } }
```

**VS Code**

```sh
code --add-mcp '{"name":"rivet","type":"http","url":"https://mcp.rivet.dev/mcp"}'
```

For other clients, see [Rivet MCP](https://rivet.dev/docs/mcp/). `orange mcp` checks whether your agent has it and prints the command for your linked cluster.

## Migrate

**Durable Objects move with zero downtime.** After you point your domain at OpenOrange, each object copies itself from Cloudflare on its first request, and a backfill copies the rest. Your app keeps serving the whole time. A D1 database takes no writes while it moves: about 3 minutes per GB in a test. Skip this section if your app has no data on Cloudflare.

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/images/step-4-migrate-dark.svg">
  <img alt="Traffic moves from Cloudflare to OpenOrange when you point DNS at it. Each Durable Object copies itself on its first request, and a backfill copies the rest" src="docs/images/step-4-migrate.svg">
</picture>

You need a Rivet cluster where `orange deploy` works, your Worker's `workers.dev` URL, a long random `WORKER_MIGRATOR_TOKEN`, and a Cloudflare API token (Workers read, D1 edit) with your account ID. Set `ORANGE_MIGRATE_WORKER_URL`, `WORKER_MIGRATOR_TOKEN`, `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID` in your shell or `.dev.vars`.

1. **Check.** Run `orange doctor`. It lists each Durable Object class that `orange migrate` can move.
2. **Prepare.** Wrap your Worker. Your code does not change.

   ```sh
   orange migrate prepare
   ```

3. **Deploy to Cloudflare.** Deploy the prepared Worker. Your users see no change.

   ```sh
   wrangler secret put WORKER_MIGRATOR_TOKEN --config wrangler.migrate.jsonc
   wrangler deploy --config wrangler.migrate.jsonc
   ```

4. **Deploy to Rivet.** Deploy the same app with your Worker's URL and the same token. OpenOrange gets no traffic yet.

   ```sh
   rivet cluster secret set WORKER_MIGRATOR_TOKEN
   orange deploy \
     --var ORANGE_MIGRATE_WORKER_URL:https://my-app.acme.workers.dev \
     --secret WORKER_MIGRATOR_TOKEN
   ```

5. **Move D1.** Run this once for each D1 database, at a quiet time. Use the URL that `orange deploy` prints.

   ```sh
   orange migrate d1 DB --url https://<orange-url>
   ```

6. **Point DNS.** Point your domain at OpenOrange. Each Durable Object copies itself from Cloudflare on its first request.
7. **Backfill.** A few minutes later, copy the objects that got no request. Run it again, a few minutes apart, until every class prints `0 moved, 0 failed`.

   ```sh
   orange migrate backfill --url https://my-app.example.com
   ```

8. **Clean up.** When no traffic reaches Cloudflare and a backfill reports 0 failed, turn the migration off. OpenOrange never deletes data on Cloudflare.

   ```sh
   rivet cluster env unset ORANGE_MIGRATE_WORKER_URL --pool <pool>
   ```

Skip step 5 if your app has no D1 database. Skip step 7 if it has no Durable Objects. See the [migration guide](https://openorange.dev/docs/migrate/) for cron triggers, rollback, and what cannot move.

### What `orange migrate prepare` does

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/images/readme-migrate-prepare-dark.svg">
  <img alt="orange migrate prepare reads your Worker, writes .open-orange/migrate/worker.mjs and wrangler.migrate.jsonc, and prints the wrangler commands that you run" src="docs/images/readme-migrate-prepare.svg">
</picture>

`prepare` writes a Worker that exports your app as it is, with three additions:

- Each SQLite Durable Object class goes through `migratable()`, which lets the object export its data.
- Each D1 binding gets a wrapper that sends its queries to OpenOrange after the database moves.
- The token-protected `/__migrate/*` routes go in front of your `fetch` handler.

`prepare` deploys nothing. It prints the `wrangler` commands, and you run them. Do not commit the two generated files.

### How a Durable Object moves

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/images/readme-migrate-durable-object-dark.svg">
  <img alt="A Durable Object starts on OpenOrange on its first request or when the backfill wakes it, copies its data from Cloudflare in pages, and then serves. Cloudflare marks it as moved and answers 503" src="docs/images/readme-migrate-durable-object.svg">
</picture>

- An object moves on its first request to OpenOrange, or when `orange migrate backfill` wakes it.
- OpenOrange pulls the data in pages before the object's constructor runs.
- Cloudflare marks the object as moved only if no write came during the copy. If a write came, the copy starts again.
- After that, Cloudflare answers 503 `migrator.moved` for the object, so no write can go to the old copy.

**To roll back,** point your domain back at Cloudflare and set `MIGRATOR_DISABLED=true` on the prepared Worker. Writes made on OpenOrange stay on OpenOrange.

Durable Objects that use the older key-value storage (`new_classes`) cannot move.

### How a D1 database moves

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/images/readme-migrate-d1-dark.svg">
  <img alt="A D1 database moves in six steps: freeze, export, import, check, switch, moved. Writes fail with a clear error until the switch. Reads fail only during the export" src="docs/images/readme-migrate-d1.svg">
</picture>

1. **Freeze.** Triggers on Cloudflare's D1 refuse every write with `orange-d1-frozen`. Reads continue.
2. **Export.** Cloudflare's D1 export API dumps the database exactly. D1 answers no query until it ends.
3. **Import.** OpenOrange reads the dump in commits of about 1 MiB. A rerun continues from the last commit.
4. **Check.** OpenOrange compares every row with the frozen D1, by SHA-256 per page of rows.
5. **Switch.** Cloudflare forwards every query for the database to OpenOrange.

If a step fails before the switch, the freeze opens, Cloudflare takes writes again, and nothing is lost.

## Caveats

- **Not every binding runs.** Vectorize, Images, Media, Stream, Pipelines, AI Search, mTLS certificates, and VPC throw on each call. Analytics Engine drops its writes. Some bindings need a service you supply. See [What runs where](#what-runs-where).
- **Compatibility dates do not apply.** OpenOrange runs one profile and ignores `compatibility_date`. It warns about each flag in `compatibility_flags` that it does not apply.
- **KV-backed Durable Objects cannot move.** Only SQLite Durable Objects (`new_sqlite_classes`) move with `orange migrate`.
- **A D1 database takes no writes while it moves,** about 3 minutes per GB in a test.
- **Cloudflare keeps your data.** OpenOrange never deletes anything on Cloudflare. Delete the Worker and its data yourself after the move.
- **Upstream workerd tests:** 1,602 of 1,774 pass (90.3%). See [Compatibility](https://openorange.dev/docs/compatibility/) and the [conformance report](packages/cloudflare-conformance/README.md).

Each [binding page](https://openorange.dev/docs/bindings/) lists every known difference from Cloudflare.

## Compare

- [OpenOrange vs Cloudflare Durable Objects](https://openorange.dev/vs-durable-objects/): limits, latency, residency, and moving off.
- [OpenOrange vs workerd](https://openorange.dev/vs-workerd/): a runtime for one Worker, versus your whole app in production.
- [OpenOrange vs celld](https://openorange.dev/vs-celld/): runtime limits, live migration, integrations, and support.
- [OpenOrange vs Rivet](https://openorange.dev/vs-rivet/): when to use Rivet directly, and how to combine them.
- [OpenOrange vs Miniflare](https://openorange.dev/vs-miniflare/): a local simulator, versus production.

## FAQ

**Is this workerd?** No. OpenOrange implements the Workers API on Node.js and maps each Cloudflare service onto Rivet. It reuses some MIT-licensed Cloudflare code, such as the Workflows engine.

**Do I change my code?** No. Your Worker, your Durable Object classes and your `wrangler.jsonc` stay as they are. `orange doctor` tells you which bindings need a provider.

**Does Wrangler still work?** Yes. OpenOrange reads your Wrangler configuration, and you keep using Wrangler for Cloudflare during a migration.

**Do native npm modules work?** Not tested yet. Packages that need Node.js APIs the Workers runtime lacks do work, because OpenOrange runs stock Node.js.

**Is it production-ready?** It's 1.0. Durable Objects, KV, D1, Queues and Cron Triggers run on Rivet Actors, the engine behind Rivet Cloud. Check each binding's status in [What runs where](#what-runs-where) and the [Compatibility](https://openorange.dev/docs/compatibility/) results.

**Who supports it?** Rivet builds and supports OpenOrange. Ask in [Discord](https://rivet.dev/discord), or [talk to an engineer](https://rivet.dev/talk-to-an-engineer/) about support contracts.

## Commands

`orange`, `open-orange`, and `openorange` are the same command.

| Command | Does |
|---|---|
| `orange dev` | Runs the Worker on your machine |
| `orange doctor` | Checks the project, reports its bindings (not its variables) and Durable Object classes, and prints the next commands |
| `orange mcp` | Says whether your coding agent has the Rivet MCP, and prints the command that connects it |
| `orange login` | Signs in to Rivet Cloud |
| `orange link --cluster <name>` | Links this directory to a Rivet cluster |
| `orange deploy` | Builds an image and rolls it out to a Rivet cluster |
| `orange serve` | Serves the Worker against the Rivet Engine in `RIVET_ENDPOINT` |
| `orange migrate prepare` | Writes the Worker and Wrangler configuration that you deploy to Cloudflare for the move |
| `orange migrate backfill --url <url>` | Copies every Durable Object that got no requests |
| `orange migrate d1 <database> --url <url>` | Moves a D1 database with Cloudflare's export API. Its writes fail until the move ends. |
| `orange types` | Generates `worker-configuration.d.ts` |
| `orange d1 execute <database>` | Runs SQL against a local D1 database |

Run `orange <command> --help` for the flags of one command.

## Resources

- [Deploy guide](https://openorange.dev/docs/deploy/): Rivet Cloud, self-hosting, variables, secrets, and rollback.
- [Migration guide](https://openorange.dev/docs/migrate/): how to cut over, how to roll back, and what cannot move.
- [Bindings](https://openorange.dev/docs/bindings/): one page for each binding and runtime API, with its known differences.
- [Architecture](https://openorange.dev/docs/architecture/): how OpenOrange runs your Worker on Rivet.
- [Examples](examples/): Workers that you can copy, with no OpenOrange imports.
- [Real projects](packages/cloudflare-conformance/real-projects): open-source Workers run through `orange dev`, with what works and what does not.
- [Discord](https://rivet.dev/discord): questions and support.

## Contributing

```sh
git clone https://github.com/rivet-dev/open-orange
cd open-orange
pnpm install
pnpm orange --help   # runs the CLI from source
pnpm typecheck
pnpm test
```

OpenOrange's compatibility contract is tested three ways, in [`packages/cloudflare-conformance`](packages/cloudflare-conformance):

- **Types.** OpenOrange's runtime is type-checked against Cloudflare's pinned Workers declarations.
- **Behavior.** Differential tests run the same Worker on Cloudflare and on OpenOrange, plus workerd's own upstream test suite.
- **Real projects.** Open-source Workers run through `orange dev`, with what works and what does not.

[`CLAUDE.md`](CLAUDE.md) is the contributor guide.

## License

[Apache-2.0](LICENSE)
