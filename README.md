<p align="center">
  <img src="docs/images/hero.png" width="560" alt="A Cloudflare Worker and its bindings run on Rivet Actors">
</p>

<h1 align="center">OpenOrange</h1>

<p align="center">Run your Cloudflare Workers and Durable Objects on Rivet with no changes to your app code.</p>

<p align="center">
  <a href="docs/deploy.mdx">Deploy</a> ·
  <a href="docs/migrate.mdx">Migrate</a> ·
  <a href="docs/modules/bindings.mdx">Bindings</a> ·
  <a href="examples/">Examples</a> ·
  <a href="https://rivet.dev/discord">Discord</a>
</p>

OpenOrange reads your Wrangler configuration and runs the same Worker on Node.js. Each Durable Object runs as a [Rivet Actor](https://rivet.dev/docs/actors/) with its own SQLite database.

## Install the MCP

Connect your coding agent to Rivet. Approve the Rivet sign-in when it opens.

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

For other clients, see [Rivet MCP](https://rivet.dev/mcp). The Rivet dashboard shows the same commands under **Settings > MCP**.

After you [install OpenOrange](#step-1-install), `orange mcp` says whether your coding agent has the Rivet MCP. If it does not, it prints the one command for the agent you use, pinned to your linked cluster:

```text
! Rivet MCP is not set up. Connect Claude Code:
  claude mcp add --transport http rivet "https://mcp.rivet.dev/mcp?cluster=prod"
```

`orange mcp --json` gives the command for every agent. Orange does not change your agent's configuration.

## Check compatibility

After you [install OpenOrange](#step-1-install), run `orange doctor` in your Worker project:

```sh
orange doctor
```

`orange doctor` reads your Wrangler configuration. It skips variables (`vars`, `.dev.vars`, and `.env`), because they need nothing on Rivet. It reports each other binding as one of three kinds:

- **Runs as is.** The binding needs no setup.
- **Needs a service you supply.** Set a variable that points to the service.
- **Not supported.** The binding loads, but Orange has no backend for it. Each call throws an error that names the binding. Analytics Engine accepts writes and drops them.

Each row links to the binding's docs. A row that needs something from you also has a hint, such as the variable to set. `orange doctor` also:

- Checks that each variable a binding needs is set in `.dev.vars`, `.env`, or your shell. A missing one counts as a thing to set up.
- Says when a binding to another Worker works only with that Worker in the same `orange dev` session.
- Says which triggers run as is, such as Cron Triggers and Tail Workers.
- Lists each Durable Object class and whether `orange migrate` can move its data. `orange migrate prepare` refuses the whole Worker while a class is KV-backed (`new_classes`) or a SQLite class has no binding. Then `orange doctor` says why, and marks no class as movable.
- Checks Node.js, the Worker bundle, the port, and the free disk for the local Rivet Engine.
- Ends with a **Next** block of the commands to run next.

For a coding agent, `--json` prints the same report as JSON Lines. `--strict` exits with 1 when something needs setup.

| Cloudflare binding | Runs on | You set |
|---|---|---|
| [Durable Objects](docs/modules/durable-objects.mdx) | One Rivet Actor for each object, with its own SQLite database | Nothing |
| [KV](docs/modules/kv.mdx), [D1](docs/modules/d1.mdx), [Rate Limiting](docs/modules/rate-limiting.mdx), [Cache](docs/modules/cache.mdx) | Rivet Actors | Nothing |
| [Queues](docs/modules/queues.mdx) | One Rivet Actor for each queue | Nothing |
| [Workflows](docs/modules/workflows.mdx) | Cloudflare's own Workflows engine, with one Rivet Actor for each instance | Nothing |
| [Cron Triggers](docs/modules/cron-triggers.mdx) | A Rivet Actor | Nothing |
| [Tail Workers](docs/modules/tail-workers.mdx) | Rivet Durable Streams | Nothing |
| [R2](docs/modules/r2.mdx) | A Rivet Actor, or your S3-compatible store | Nothing, or `ORANGE_R2_<BUCKET>_S3_ENDPOINT` and its access keys for Amazon S3, Cloudflare R2, Google Cloud Storage, or Backblaze B2 |
| [Worker Loader](docs/modules/worker-loader.mdx) | A separate process in an agentOS VM | Nothing |
| [Workers AI](docs/modules/workers-ai.mdx) | An OpenAI-compatible provider | `OPENROUTER_API_KEY`, or `ORANGE_AI_BASE_URL` and `ORANGE_AI_API_KEY` for OpenAI, Groq, Together AI, or Fireworks AI |
| [Send Email](docs/modules/email.mdx) | Your SMTP server | `ORANGE_EMAIL_SMTP_URL`: Amazon SES, Resend, Postmark, SendGrid, or Mailgun |
| [Browser Rendering](docs/modules/browser-rendering.mdx) | A hosted browser, or your Chrome | `ORANGE_BROWSER_CDP_URL`: Browserbase, Browserless, or Steel |
| [Hyperdrive](docs/modules/hyperdrive.mdx) | Your database, with a direct connection | The connection string, as for `wrangler dev`: PlanetScale, Amazon RDS, Neon, or Supabase |
| [Sandbox](docs/modules/sandbox.mdx) | A sandbox provider | `ORANGE_SANDBOX_PROVIDER`: `e2b`, `daytona`, `freestyle`, `agentos`, or `local` (default) |
| Analytics Engine | Nothing. `writeDataPoint()` drops each data point | |
| Vectorize, Images, Media, Stream, Pipelines, AI Search, mTLS certificates, VPC, and legacy blobs | Not supported. Calls throw | |

See the [compatibility matrix](docs/modules/bindings.mdx) for every binding and Wrangler key.

## Set up

You need:

- A Worker project with a `wrangler.jsonc`, `wrangler.json`, or `wrangler.toml`. If you have none, use [`examples/hello-durable-object`](examples/hello-durable-object).
- Node.js 22 or later, and pnpm.
- Docker, to deploy.

### Step 1: Install

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/images/step-1-install-dark.svg">
  <img alt="OpenOrange reads the wrangler.jsonc and source files that your Worker already has" src="docs/images/step-1-install.svg">
</picture>

Install the CLI globally:

```sh
pnpm add -g open-orange
```

You now have the `orange` command. Run it in your Worker project. Your code and your Wrangler configuration did not change.

### Step 2: Run your Worker

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

### Step 3: Deploy

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

See the [deploy guide](docs/deploy.mdx) for every flag, rollback, and CI tokens.

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

## Migrate

`orange migrate` moves SQLite Durable Objects and D1 databases from Cloudflare while your app serves. Durable Objects need no maintenance window. A D1 database takes no writes while it moves: about 3 minutes per GB in a test. Skip this section if your app has no data on Cloudflare.

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/images/readme-migrate-path-dark.svg">
  <img alt="Check with orange doctor, prepare the Worker, deploy it to Cloudflare, deploy to Rivet, move D1, point DNS at Rivet, run the backfill, then clean up. Traffic moves when you point DNS" src="docs/images/readme-migrate-path.svg">
</picture>

1. **Check.** Run `orange doctor`.
2. **Prepare.** Wrap your Cloudflare Worker. Your code does not change.

   ```sh
   orange migrate prepare
   ```

3. **Deploy to Cloudflare.** Deploy the prepared Worker. Your users see no change.

   ```sh
   pnpm wrangler secret put WORKER_MIGRATOR_TOKEN --config wrangler.migrate.jsonc
   pnpm wrangler deploy --config wrangler.migrate.jsonc
   ```

4. **Deploy to Rivet.** Run `orange deploy` with two more settings: `ORANGE_MIGRATE_WORKER_URL`, set to your `workers.dev` URL, and `WORKER_MIGRATOR_TOKEN`, set to the same token.
5. **Move D1.** Run this command for each D1 database. Use the URL that `orange deploy` prints. Its writes fail until the move ends.

   ```sh
   orange migrate d1 <database> --url <orange-url>
   ```

6. **Point DNS.** Point your domain at OpenOrange. Each Durable Object now copies itself from Cloudflare on its first request.
7. **Backfill.** Wait a few minutes, then copy the Durable Objects that got no requests. Run the command again after a few more minutes, because Cloudflare lists new objects late.

   ```sh
   orange migrate backfill --url https://app.example.com
   ```

8. **Clean up.** Remove `ORANGE_MIGRATE_WORKER_URL` after a backfill reports 0 failed. OpenOrange never deletes data on Cloudflare.

Skip step 5 if your app has no D1 database. Skip step 7 if it has no Durable Objects.

`migrate d1` and `migrate backfill` read `ORANGE_MIGRATE_WORKER_URL` and `WORKER_MIGRATOR_TOKEN` from your shell or `.dev.vars`. `migrate backfill` and `migrate d1` also need `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID`. See the [migration guide](docs/migrate.mdx) for failures and limits.

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

## Compatibility

- **Upstream workerd tests:** 1,602 of 1,774 pass (90.3%). OpenOrange also runs 77 Durable Object tests that it ports from workerd's C++ tests, and 68 of them pass. The score counts only the upstream tests. See the [report](packages/cloudflare-conformance/README.md).
- **WebSocket hibernation is emulated.** The Durable Object leaves memory and its sockets stay open, but its Rivet Actor stays running.
- **Compatibility dates do not apply.** OpenOrange runs one profile and ignores `compatibility_date`. It warns about each flag in `compatibility_flags` that it does not apply.

Each [module page](docs/modules/index.mdx) lists every known difference from Cloudflare.

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

- [Deploy guide](docs/deploy.mdx): variables, secrets, rollback, and self-hosting.
- [Migration guide](docs/migrate.mdx): how to cut over, how to roll back, and what cannot move.
- [Modules](docs/modules/index.mdx): one page for each binding and runtime API, with its known differences.
- [Examples](examples/): Workers that you can copy, with no OpenOrange imports.
- [Real projects](packages/cloudflare-conformance/real-projects): open-source Workers run through `orange dev`, with what works and what does not.
- [Discord](https://rivet.dev/discord): questions and support.
