# Queues

A job runner and an event log on two queues. Jobs retry with backoff and land
in a dead letter queue when they run out of retries. Events show each content
type and batch-level retries.

## What it shows

| API | Where |
|---|---|
| `send(body, { delaySeconds })` | `POST /jobs` |
| `sendBatch(messages, { delaySeconds })` with a delay per message | `POST /jobs/batch` |
| `send(body, { contentType })` with `text`, `bytes`, and `json` | `POST /events?contentType=...` |
| `message.retry({ delaySeconds })`, `message.ack()`, `message.attempts` | `jobs` consumer |
| `batch.retryAll({ delaySeconds })`, `batch.ackAll()` | `events` consumer |
| `max_batch_size`, `max_batch_timeout`, `max_retries`, `retry_delay` | `wrangler.jsonc` |
| `dead_letter_queue`, consumed by the same Worker | `jobs-failed` consumer |
| `queue.metrics()` backlog | `GET /metrics` |
| `send()` errors for a bad delay or content type | `400` responses |

One `queue()` handler serves all three queues and picks the consumer from
`batch.queue`.

## Run it

From this directory:

```sh
pnpm open-orange dev     # or: pnpm wrangler dev --port 8788
```

## Try it

```sh
J=localhost:8787/jobs

curl -X POST $J -d '{"id":"a"}'                          # done on attempt 1
curl -X POST $J -d '{"id":"b","failUntilAttempt":1}'     # retried after 1 s, done on attempt 2
curl -X POST $J -d '{"id":"c","failUntilAttempt":9}'     # 3 attempts, then the dead letter queue
curl -X POST $J -d '{"id":"d","delaySeconds":2}'         # delivered after 2 s
curl -X POST $J/batch -d '{"delaySeconds":1,"jobs":[{"id":"x"},{"id":"y","delaySeconds":5}]}'
curl $J          # results, waitedMs per job, and the largest batch seen (at most 5)

curl -X POST $J -d '{}'                                  # 400, no id
curl -X POST $J -d '{"id":"e","delaySeconds":90000}'     # 400, the limit is 86400 s

E=localhost:8787/events
curl -X POST "$E?contentType=text" -d hello              # a string
curl -X POST "$E?contentType=bytes" --data-binary @README.md   # an ArrayBuffer
curl -X POST $E -d '{"kind":"signup"}'                   # json, the default
curl -X POST $E -d '{"kind":"flaky"}'                    # retryAll() once, so attempts is 2
curl -X POST "$E?contentType=xml" -d '<a/>'              # 400, unsupported content type
curl $E

curl localhost:8787/metrics                              # {"backlogBytes":0,"backlogCount":0}
```

`queue.metrics()` is newer than most Queues code. The route returns `501` on a
runtime that does not have it.

## Restarts

Messages persist across `open-orange dev` restarts.
