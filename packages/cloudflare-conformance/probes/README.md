# Probes

Small Workers written to measure one surface: SQLite, limits, and how each binding scales. Each runs through `orange dev`, and a probe with `baseline: true` also runs on `wrangler dev`. Steps state Cloudflare's behaviour, so:

| Orange | workerd | Meaning |
|---|---|---|
| pass | pass | Same |
| fail | pass | A difference: Orange does not do it |
| pass | fail | Orange goes beyond workerd |

`wrangler dev` does not enforce the platform's CPU, memory, and subrequest limits, so those claims quote Cloudflare's docs and rest on the Orange result alone.

```sh
pnpm real-projects --probes
```

`src/commands/truth-table.ts` reads the results to build `compat/truth-table.json`.

`email` and `browser-rendering` talk to real servers on fixed local ports, which their `devVars` name:

| Probe | Needs |
|---|---|
| `email` | Docker. It starts Mailpit (`axllent/mailpit`) as `oo-conformance-mailpit` on ports 11025 and 18025, and leaves it running for later runs. |
| `browser-rendering` | A headless Chromium: `OPEN_ORANGE_TEST_CHROMIUM`, or Playwright's headless shell. Set `OPEN_ORANGE_TEST_CHROMIUM_LIBS` to a directory of shared libraries if the machine lacks them. It runs on port 19222 for the run only. |
