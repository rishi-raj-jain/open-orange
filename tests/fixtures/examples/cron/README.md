# Cron Triggers

A Worker with five scheduled jobs: a heartbeat, a nightly cleanup, a month-end
report, a monthly digest, and an upstream sync that always fails. One
`scheduled()` handler picks the job from `controller.cron`.

## What it shows

- `triggers.crons` with standard and Cloudflare-only syntax:

  | Cron | Job | Runs |
  |---|---|---|
  | `*/5 * * * *` | heartbeat | every 5 minutes |
  | `0 3 * * *` | nightly-cleanup | 03:00 UTC every day |
  | `0 18 LW * *` | month-end-report | 18:00 UTC on the last weekday of the month |
  | `0 9 * * 2#1` | monthly-digest | 09:00 UTC on the first Monday. Weekdays are 1 (Sunday) to 7 (Saturday) |
  | `15 * * * *` | upstream-sync | minute 15 of every hour. It always throws |

- `controller.cron` and `controller.scheduledTime`. Each job records its last
  `scheduledTime`, outcome, error, and run count in KV.
- `ctx.waitUntil()`. The event waits for every `waitUntil()` promise, and a
  rejected one fails the event even after the handler returned.
- `controller.noRetry()` for a cron that has no job.
- The local `/cdn-cgi/local/scheduled` route, and `/__scheduled` with
  `--test-scheduled`.

## Run it

From this directory:

```sh
pnpm open-orange dev     # or: pnpm wrangler dev --port 8788
```

Open Orange runs each cron on its schedule, in UTC. Wrangler never runs crons
in dev, so use the routes below there.

The ready block has one `Cron` row per schedule with its next run, and a
`Run one now` command for the first schedule:

```text
Cron     "*/5 * * * *" next 2026-10-21T01:05:00.000Z
         "0 3 * * *" next 2026-10-21T03:00:00.000Z
         ...
         Run one now: curl "http://localhost:8787/cdn-cgi/local/scheduled?cron=*%2F5%20*%20*%20*%20*"
```

An invalid cron does not stop the server. Open Orange prints
`Orange skips cron trigger ...` with the reason and leaves out its row.

## Try it

`/cdn-cgi/local/scheduled` runs `scheduled()` now. `cron` sets
`controller.cron` and `time` sets `controller.scheduledTime` in epoch
milliseconds. It returns `ok` (200) or `exception` (500). Add `format=json` to
get `{"outcome","noRetry"}`.

```sh
S=localhost:8787/cdn-cgi/local/scheduled

curl "$S?cron=*/5+*+*+*+*"                                  # ok
curl -X PUT localhost:8787/tmp/a -d 1                        # a temporary key
curl "$S?cron=0+3+*+*+*"                                    # ok, deletes tmp:*
curl localhost:8787/tmp                                      # {"keys":[]}
curl "$S?cron=0+18+LW+*+*&time=1793383200000"               # ok, writes report:2026-10
curl "$S?cron=0+9+*+*+2%231&format=json"                    # exception: no subscribers
curl -X POST localhost:8787/digest/subscribe
curl "$S?cron=0+9+*+*+2%231"                                # ok
curl "$S?cron=15+*+*+*+*&format=json"                       # {"noRetry":false,"outcome":"exception"}
curl "$S?cron=1+2+3+4+5&format=json"                        # {"noRetry":true,"outcome":"exception"}
curl localhost:8787/                                         # every job's last run
```

Encode `#` as `%23` in a URL. The thrown error and its stack go to the
`open-orange dev` log.

With `pnpm open-orange dev --test-scheduled`, Wrangler's older route also works.
It returns `Ran scheduled event` or a 500. Without the flag, the Worker gets
the request and returns its 404.

```sh
curl "localhost:8787/__scheduled?cron=*/5+*+*+*+*"
```
