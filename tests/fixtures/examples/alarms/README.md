# Alarms

Reminders that fire later, even if the Durable Object sleeps in between.

## What it shows

- Each object has one alarm. `setAlarm()` keeps it at the earliest pending
  reminder.
- The runtime calls `alarm()` at that time. The handler marks due reminders
  as fired and sets the alarm for the next one.
- The reminders live in the object's SQLite database.

## Run it

From this directory:

```sh
pnpm open-orange dev     # or: pnpm wrangler dev --port 8788
```

## Try it

```sh
curl localhost:8787/reminders/me -d '{"text":"stretch","inSeconds":5}'
curl localhost:8787/reminders/me -d '{"text":"lunch","inSeconds":3600}'
curl localhost:8787/reminders/me
```

After 5 seconds, `stretch` has a `firedAt` time and `lunch` is still pending.
A body without `text`, or with an `inSeconds` that is not a positive number,
gets 400.
