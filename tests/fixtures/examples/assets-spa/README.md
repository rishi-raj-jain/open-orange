# Static assets with a single-page app

A static single-page app with a Worker that serves only its API.

## What it shows

- `assets.directory` serves the files in `public/`.
- `not_found_handling: "single-page-application"` serves `index.html` for
  unknown paths, so the browser app can route `/about`.
- `run_worker_first: ["/api/*"]` sends API requests to the Worker. An unknown
  API route gets a JSON 404 from the Worker, not `index.html`.

## Run it

From this directory:

```sh
pnpm open-orange dev     # or: pnpm wrangler dev --port 8788
```

## Try it

Open <http://localhost:8787/> and click **About**. Reload the page on
`/about`: the app still loads. Then try the API:

```sh
curl localhost:8787/api/hello     # {"message":"Hello from the Worker"}
curl localhost:8787/api/missing   # 404 {"error":"No API route for /api/missing"}
```
