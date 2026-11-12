# `orange dev` ignores the Wrangler `alias` field

[`alias`](https://developers.cloudflare.com/workers/wrangler/configuration/#module-aliasing) maps an import specifier to a local file at bundle time. Orange does not read it. cloudflare/vibesdk uses it for its vendored `artifacts-viewer`, so the project cannot boot from its `wrangler.jsonc`.

```sh
orange dev --config wrangler.jsonc --port 8787
curl http://127.0.0.1:8787/
```

Expected (as on `wrangler dev`): `aliased`.

Actual: `orange dev` exits with code 1.

```
! worker.js imports "my-alias", which fails when that module evaluates
× No such module "my-alias".
  imported from "worker.js"
```

Verified with `orange` at b4cc11a on the devbox.
