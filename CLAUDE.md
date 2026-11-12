# Contributor guide

## Commits and pull requests

- Commit titles and pull request titles are conventional commits (`feat`, `fix`, `chore`, `docs`, `refactor`), with an optional scope.
- A pull request description is a short, high-level bullet list of what changed.

## Cloudflare conformance workflow

- When updating the pinned Wrangler version or supported compatibility date and
  flags, run the Cloudflare conformance CLI's `generate` command, review the API
  and Wrangler CLI-help diffs, run `check`, and record any confirmed deviations.
- Keep Orange's complete command tree and normalized help output aligned with
  the pinned Wrangler release. Help parity proves only CLI surface parity;
  command behavior must have its own conformance fixtures.
- When implementing a command, global, binding, module export, or other coherent
  API slice, enable it in `support.json` as partial, run `check`, and iterate on
  the implementation and Cloudflare comparison tests without weakening the
  generated types. Mark it implemented only after its behavioral conformance
  tests pass.

## Cloudflare implementation references

- When Cloudflare behavior or an implementation approach is unclear, inspect
  the workerd source and, where useful, the historical Miniflare v2 TypeScript
  source. Treat them as implementation references; the pinned declarations and
  differential conformance checks remain Orange's compatibility contract.
- Prefer workerd for current runtime semantics. Miniflare v2 is useful for its
  JavaScript/TypeScript implementation patterns, but it predates modern Workers
  RPC and is not an oracle for Durable Object method RPC.
- Whenever Orange code materially follows or adapts specific workerd or
  Miniflare v2 behavior, add a concise comment beside that code explaining what
  is mirrored and linking to the exact upstream lines. The URL must be a GitHub
  permalink containing a full commit SHA and line range, never a moving branch
  or tag URL. This applies even when the implementation is adapted rather than
  copied, including protocol details and edge cases such as stream extraction.

## Upstream example corpus

- Manually copy upstream examples into `tests/examples/<area>/<id>/`; tests must
  never fetch mutable examples at runtime.
- Every example has an `example.json` manifest with exactly one stable `id`, a
  repository-relative `source` entrypoint, a repository-relative
  `wranglerConfig`, the upstream `reference` URL it was copied from, and an
  `expectation` of `expected-pass` or `known-broken`.
- A `known-broken` example must include a concise `reason`. Keep its source
  unchanged so it remains evidence of an OpenOrange gap, and update its
  expectation when the gap is fixed.
- Run `tsx tests/validate-example-manifests.ts` after adding or changing an
  example. The validator checks manifest shape, unique IDs, referenced local
  files, valid reference URLs, and required known-broken reasons; it does not
  fetch or execute examples.

## Runnable examples

- Keep `examples/<name>/` as plain Cloudflare Workers projects with no
  OpenOrange imports, a `wrangler.jsonc`, and a `README.md`.
- `examples/` holds only what a user would copy: a starting point, or Orange
  configuration that Cloudflare's own docs cannot teach. An example that only
  proves a feature goes in `tests/fixtures/examples/`. Real proof goes in
  `packages/cloudflare-conformance/real-projects/`.
- Every example and example fixture needs one end-to-end scenario in
  `tests/runnable-examples.test.ts`; the test fails for one without a scenario.
- Upstream copies used as compatibility evidence stay in `tests/examples/`.

## Module documentation

- Keep one public MDX document for each Cloudflare runtime capability tracked by
  the current milestone under `docs/modules/`, including capabilities that are
  still unimplemented. Update it in the same commit whenever configuration,
  behavior, conformance status, or deviations change.
- Each module document must state its support status, show Wrangler-compatible
  configuration, explain how Orange implements it, describe its behavioral and
  type conformance coverage, and list every known deviation from Cloudflare,
  in the [binding page format](#binding-page-format).
- Never put secret values, credentials, or private infrastructure details in
  public docs.

### Binding page format

Every binding page in `docs/modules/` is written for a person first, with the
detail that only an agent needs collapsed at the end.
`docs/modules/durable-objects.mdx` is the reference page. The docs components
live in `website/src/components/docs/`, and pages use them without an import.

Sections, in this order:

1. **Status summary.** `<BindingStatus>` right after the `# Title`. Its
   status, backend, Wrangler keys, scaling, and check counts come from the
   conformance data, and its migration value from
   `website/src/data/binding-migration.ts`. The page writes three one-line
   props: `works`, `differs`, and `missing`.
2. **`## Configuration`.** The shortest path to a working binding, as
   `<Steps>`: the `wrangler.jsonc`, the code, and a run with its output. Then
   at most one short table of what Orange reads differently from Wrangler.
3. **`## Compatibility`.** One table of `Feature | Status | Notes`, with the
   status `Supported`, `Partial`, or `Not supported`. Then at most three
   bullets on the differences that most projects hit. It is the page's only
   list of API status. A page with `<BindingStatus>` gets no generated
   compatibility section.
4. **`## How it works`.** What runs the binding and what that means for the
   reader, in a few short paragraphs, or a diagram and a few bullets.
5. **`## Limits`.** One table of `What | Limit | What happens over it`, for
   the limits a user can hit.
6. **`<AiContext>`.** Everything else: exhaustive API tables, edge cases,
   internals, measurements, debugging tables, every known deviation, the
   conformance coverage, and `<BindingEvidence>` with the recorded results.

Each binding's migration value is one of four, with one line of detail and a
link to the guide when there is a path:

- **Live migration:** the app keeps serving while the data moves, as with
  `orange migrate`'s copy on first request and backfill.
- **Migration with downtime:** a supported path that needs a cutover or a
  maintenance window, such as an export and import.
- **Not supported:** the binding holds data on Cloudflare, and Orange has no
  way to move it yet.
- **Not needed:** stateless or external, so there is nothing to move.

Change a value in the same commit as the migration code or guide.

Writing rules:

- Write for someone setting the binding up or deciding whether to use it.
  Short sentences, present tense, "you". Lead each section with what the
  reader does or gets.
- Say each fact once. Do not restate the status summary in prose, keep API
  status in the Compatibility table only, and do not repeat the human sections
  inside `<AiContext>`.
- A human section is about one screen. When it needs more than a table and a
  few bullets, move the rest into `<AiContext>`.
- `<Steps>`: four to six steps, each titled with an imperative verb, about two
  sentences each. Requirements go above `<Steps>`, never in step 1. Every
  command shows its real output, from an actual run.
- Configuration examples use `wrangler.jsonc`.
- Inside `<AiContext>`, use `####` and `#####` headings, so "On this page"
  lists only the human sections. Keep the anchors that other pages link to.
- Every diagram has a light and a dark version: `x.svg` and `x-dark.svg` in
  `docs/images/`.

A guide that is not a binding page, such as `docs/deploy.mdx`, opens with a
`## Quickstart` as `<Steps>`, then a short section per task, then
`<AiContext>` with the reference: every flag, refused value, and error.

Skeleton:

```mdx
---
title: KV
description: One sentence on what runs the binding on OpenOrange.
---

# KV

<BindingStatus
  binding="kv"
  works="One line: what runs as on Cloudflare"
  differs="One line: what behaves differently"
  missing="One line: what is not there"
/>

## Configuration

<Steps>
<Step title="Bind the namespace">

One or two sentences, then the `wrangler.jsonc`.

</Step>
<Step title="Run it">

The command, then its output.

</Step>
</Steps>

## Compatibility

| Feature | Status | Notes |
| --- | --- | --- |

## How it works

## Limits

| What | Limit | What happens over it |
| --- | --- | --- |

<AiContext summary="Every API detail, deviation, and the test evidence">

#### Deviations

#### Conformance

<BindingEvidence bindings={["kv"]} />

</AiContext>
```

### Module completion checklist

A module is not complete until the same commit includes all three:

- Its implementation under `packages/runtime-node/src/` in the appropriate
  globals, modules, bindings, or events folder.
- Its `docs/modules/` MDX page with support status, Wrangler-compatible
  configuration, implementation details, conformance coverage, and known
  deviations.
- Its static type-conformance and behavioral conformance tests, with its status
  accurately registered in `support.json`.

## Agent skill

- `skills/rivet-open-orange/` is the agent skill for running, deploying, and
  migrating with Orange. `.github/workflows/sync-skill.yml` publishes it to
  `rivet-dev/skills` on each push to `main`, and the Rivet MCP serves it.
- When a commit changes a command, flag, output line, `orange doctor --json`
  event, or step that the skill names, update the skill in the same commit.

## Website docs

- `website/` builds every docs page from `docs/*.mdx` and `docs/modules/*.mdx`,
  and its compatibility and binding status pages from
  `packages/cloudflare-conformance/` results, at build time. Edit those sources,
  never copies inside `website/`.
- The only hand-written docs page is the introduction,
  `website/src/pages/docs/index.astro`. Its intro and quickstart mirror
  `README.md`. When either changes, update the other in the same commit so both
  show the same steps, commands, and order.

## Development scripts

- Write repository automation scripts in TypeScript and run them with `tsx`.
  Do not add JavaScript, `.mjs`, or `.cjs` scripts.
