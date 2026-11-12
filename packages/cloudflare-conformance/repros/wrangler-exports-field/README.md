# `orange dev` refuses a config with the `exports` field

Found on `shuaiplus/inkstone` (`wrangler.toml`), which declares its Durable Objects with `[exports.<Class>]` and has no `migrations` list.

```sh
orange dev --config wrangler.jsonc --port 8787
curl http://127.0.0.1:8787/
```

- **Expected:** `orange dev` boots, `Counter` is a SQLite-backed Durable Object, and `curl` returns `{"value":1}`.
- **Actual:** `orange dev` exits with code 1 and prints `× Unsupported Wrangler configuration: exports`.
