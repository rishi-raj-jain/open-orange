# Workers Sites (`[site]`) stops `orange dev`

A Wrangler config with `site.bucket` does not boot. Found on cloudflare/meet, whose `server.ts` reads `__STATIC_CONTENT_MANIFEST` and `env.__STATIC_CONTENT`.

```sh
orange dev
curl http://127.0.0.1:<port>/
```

- Expected: `orange dev` starts, and `curl` prints `hello`.
- Actual: `orange dev` exits with code 1: `Unsupported Wrangler configuration: site`.
