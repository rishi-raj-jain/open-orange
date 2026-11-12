# Facets and Worker Loader

An agents-style notes app. A `Workspace` Durable Object keeps each user's
notes in a facet: a child Durable Object with its own SQLite database. Users
can also send code that runs over their notes in a Worker that the Worker
Loader starts, with no network access.

## What it shows

- `ctx.facets.get(name, callback)` creates one child object per user. The
  facet class (`Notes`) needs no binding and no migration.
- The callback runs only when the facet is not running. It reads the class
  from `ctx.exports`.
- `ctx.facets.abort(name, reason)` stops a running facet. Calls in flight and
  calls on old stubs fail with the reason. The next `get()` loads a new class
  (`NotesV2`) over the same data.
- `ctx.facets.delete(name)` stops the facet and erases its database. Other
  users keep their data.
- `env.LOADER.get(id, callback)` runs user code in its own isolate. The id is
  a hash of the code, so the same code reuses the loaded Worker.
- `globalOutbound: null` blocks `fetch()` and `connect()` in user code.
- Syntax errors and thrown errors reach the caller with their name and message.

## Run it

From this directory:

```sh
pnpm open-orange dev     # or: pnpm wrangler dev --port 8788
```

## Try it

```sh
ada=localhost:8787/workspaces/team/users/ada

curl -X POST $ada/notes -d ' buy milk '    # 201 {"id":1,"text":" buy milk "}
curl -X POST $ada/notes -d ''              # 400
curl $ada/notes                            # {"notes":[...],"version":1}

curl -X POST $ada/upgrade                  # aborts the facet, loads NotesV2
curl -X POST $ada/notes -d ' call home '   # NotesV2 trims: {"id":2,"text":"call home"}

curl -X POST $ada/run -d 'export default { run(notes) { return notes.length; } };'
curl -X POST $ada/run -d "export default { async run() { return (await fetch('https://example.com')).status; } };"  # 422, no network
curl -X POST $ada/run -d 'export default { run( };'                                                                 # 422, SyntaxError

curl -X DELETE $ada                        # deletes ada's facet and data
curl $ada/notes                            # {"notes":[],"version":1}
```
