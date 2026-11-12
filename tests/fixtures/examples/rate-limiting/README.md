# Rate Limiting

An API with layered limits: a per-IP limit on every route, a per-user API
limit with a higher limit for pro users, and login throttling that answers
`429` with `Retry-After`.

## What it shows

- Four `ratelimits` bindings with different `simple` limits and periods:

  | Binding | `namespace_id` | Limit | Key |
  |---|---|---|---|
  | `IP_LIMITER` | `1001` | 10 per 10 s | client IP (`cf-connecting-ip`) |
  | `USER_LIMITER` | `1002` | 5 per 60 s | `user:<name>` |
  | `LOGIN_LIMITER` | `1003` | 3 per 60 s | `account:<username>` |
  | `RESET_LIMITER` | `1003` | 3 per 60 s | `account:<username>` |

- A shared `namespace_id`. `LOGIN_LIMITER` and `RESET_LIMITER` count against
  the same counter for the same key, so password resets use the login budget.
- The per-call override: `limit({ key, limit: 20 })` gives pro users a higher
  limit from the same binding. `limit` and `period` can both be overridden.
- `429` responses with a `Retry-After` header that counts the seconds to the
  end of the current window.
- Invalid options throw: a period other than `10` or `60`, a non-number limit,
  or an unknown option.

## Run it

From this directory:

```sh
pnpm open-orange dev     # or: pnpm wrangler dev --port 8788
```

## Try it

Send `cf-connecting-ip` to act as another client. Without it, every request
comes from `127.0.0.1`, so the per-IP limit of 10 per 10 seconds applies to all
your curls together.

```sh
# Per-user limit: the 6th call in a minute gets 429.
for i in 1 2 3 4 5 6; do curl -i -H 'cf-connecting-ip: 10.0.0.1' 'localhost:8787/api/me?user=ada'; done

# Per-call override: pro users get 20 per minute.
for i in 1 2 3 4 5 6; do curl -H 'cf-connecting-ip: 10.0.0.2' 'localhost:8787/api/me?user=grace&plan=pro'; echo; done

# Per-IP limit: the 11th request from one IP in 10 seconds gets 429, for any user.
for i in $(seq 1 11); do curl -s -o /dev/null -w '%{http_code}\n' -H 'cf-connecting-ip: 10.0.0.3' "localhost:8787/api/me?user=u$i"; done

# Login throttling: 3 attempts per minute for each account, right or wrong.
curl -X POST -H 'cf-connecting-ip: 10.0.0.4' localhost:8787/login -d '{"username":"bob","password":"guess"}'          # 401
curl -X POST -H 'cf-connecting-ip: 10.0.0.4' localhost:8787/password-reset -d '{"username":"bob"}'                   # 202, uses the same budget
curl -X POST -H 'cf-connecting-ip: 10.0.0.4' localhost:8787/login -d '{"username":"bob","password":"correct-horse"}' # 200
curl -i -X POST -H 'cf-connecting-ip: 10.0.0.4' localhost:8787/login -d '{"username":"bob","password":"correct-horse"}' # 429, Retry-After

# Per-call override and invalid options.
curl 'localhost:8787/probe?key=k&limit=1'     # {"success":true}, then {"success":false}
curl 'localhost:8787/probe?key=k&period=30'   # 400 "unsupported period: 30"
```

## Differences from Cloudflare

- Orange counts exactly, in one place. Cloudflare counts per location and is
  eventually consistent, so it can let a few extra requests through.
- Orange windows start on wall-clock multiples of the period. Cloudflare does
  not document where its windows start.
