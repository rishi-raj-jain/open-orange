# `orange dev` rejects a Vite build's generated config

`@cloudflare/vite-plugin` writes `"legacy_env": true` into `build/server/wrangler.json` (seen with plugin 1.29.0 and wrangler 4.74.0, in cloudflare/agentic-inbox). Orange parses configs with its own wrangler 4.129.0, which refuses this field.

```sh
orange dev --config wrangler.json --port 8787
curl http://127.0.0.1:8787/
```

Expected: `ok`. The project's own wrangler accepts the file, and the field has no effect (the error text says so).

Actual: `orange dev` exits with code 1.

```
× Processing wrangler.json configuration:
  - The "legacy_env" field is no longer supported, so please remove it from your configuration file.
```

Effect: a project pinned to an older Vite plugin cannot start from its own build output.

Verified with `orange` at b4cc11a on the devbox.
