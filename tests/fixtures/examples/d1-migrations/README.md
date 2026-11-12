# D1 migrations

A comments API on a D1 database whose schema comes from SQL migration files.

Adapted from Cloudflare's
[`d1-template`](https://github.com/cloudflare/templates/tree/dfdf14099a81a08cfe1ffc78f8463605670ae513/d1-template)
(MIT License, Copyright (c) 2018, Cloudflare, Inc.).

## What it shows

- `migrations/` holds numbered SQL files. `orange d1 migrations apply` runs
  the new ones in order and records them, like Wrangler.
- `prepare()`, `bind()`, `all()`, and `first()` with `RETURNING`.

## Run it

From this directory, apply the migrations, then start the Worker:

```sh
pnpm open-orange d1 migrations apply DB
pnpm open-orange dev
```

## Try it

```sh
curl localhost:8787/comments
curl localhost:8787/comments -d '{"author":"Ada","content":"Nice work"}'
curl 'localhost:8787/comments?author=Ada'
```

The first request returns the three seed comments. A POST without `author` or
`content` gets 400. If you skip the migrations, requests get 500 and
`open-orange dev` logs `D1_ERROR: no such table: comments`.
