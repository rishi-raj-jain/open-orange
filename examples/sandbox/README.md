# Sandbox

A small code runner. Each user gets their own sandbox where the Worker runs
commands, streams output, edits files, clones a Git repository, and serves a
web server on a preview URL. It uses the Cloudflare Sandbox SDK,
`@cloudflare/sandbox`, with no OpenOrange imports.

## What it shows

- `getSandbox(env.Sandbox, userId)`: one sandbox per user id. Each sandbox is
  a `Sandbox` Durable Object.
- `exec()` with `cwd`, `env`, and `timeout`. A command that fails returns its
  `exitCode` and `stderr`; it is not an HTTP error.
- `execStream()` returned as Server-Sent Events (`start`, `stdout`, `stderr`,
  `complete`).
- `writeFile()`, `readFile()`, `exists()`, `mkdir()`, `deleteFile()`, and
  `listFiles()`, with a 404 for a missing file.
- `gitCheckout()`. Without a URL, the Worker makes a tiny repository inside
  the sandbox and clones it, so it works offline. If `git` is not installed,
  the route returns a 503 and skips the checkout.
- `startProcess()`, `waitForPort()`, and `exposePort()` for a preview URL, with
  `proxyToSandbox()` in `fetch` to serve it. A second start returns a 409.
- `listProcesses()`, `getProcessLogs()`, and `killProcess()`.
- `destroy()`. The next call gets a new, empty sandbox.

## Run it

From this directory:

```sh
pnpm open-orange dev
```

`wrangler dev` needs Docker for the container image in `Dockerfile`, and the
`@cloudflare/sandbox` package (`pnpm add @cloudflare/sandbox`). `open-orange
dev` needs neither. It replaces the package with its own module and runs each
sandbox on the provider that `ORANGE_SANDBOX_PROVIDER` picks.

## Try it

```sh
U=localhost:8787/users/ada

# Run commands
curl -X POST $U/run -d '{"command":"echo hi; node --version"}'
curl -X POST $U/run -d '{"command":"echo $GREETING","env":{"GREETING":"hello"}}'
curl -X POST $U/run -d '{"command":"exit 3"}'              # 200, exitCode 3
curl -X POST $U/run -d '{"command":"sleep 5","timeout":500}'
curl -X POST $U/run -d '{}'                                # 400

# Stream output as Server-Sent Events
curl -N -X POST $U/stream -d 'for i in 1 2 3; do echo $i; sleep 1; done'

# Files
curl -X PUT $U/files/notes/todo.txt -d 'ship it'
curl $U/files/notes/todo.txt
curl $U/files
curl $U/files/missing.txt                                  # 404
curl localhost:8787/users/bob/files/notes/todo.txt         # 404: another sandbox
curl -X DELETE $U/files/notes/todo.txt

# Git
curl -X POST $U/git                                        # clones a local demo repo
curl -X POST "$U/git?url=https://github.com/octocat/Hello-World"   # needs network

# A web server on a preview URL
curl -X POST "$U/server?port=8080"                         # 201 with previewUrl
curl http://8080-ada-<token>.localhost:8787/hello          # the previewUrl: served by the sandbox
curl http://8080-ada-wrongtoken.localhost:8787/hello       # 404 INVALID_TOKEN
curl -X POST "$U/server?port=8080"                         # 409
curl $U/processes
curl $U/processes/web/logs
curl -X DELETE $U/processes/web                            # status: killed

# Delete the sandbox
curl -X DELETE $U
```

If `*.localhost` does not resolve on your system, send the preview host as a
header: `curl -H 'host: 8080-ada-<token>.localhost:8787' localhost:8787/hello`.

## Restarts

After `destroy()`, the stored id is gone. Restart `open-orange dev` and call the
same user again: the actor reconnects to the same sandbox, so the files are
still there.

## Choose a sandbox provider

Set these in the shell that runs `open-orange dev`:

| `ORANGE_SANDBOX_PROVIDER` | Runs commands in | Also set |
| --- | --- | --- |
| `local` (default) | Host processes. **Not isolated.** | `ORANGE_SANDBOX_DIR` (optional) |
| `e2b` | An E2B micro-VM | `E2B_API_KEY`, and `pnpm add e2b` |
| `daytona` | A Daytona sandbox | `DAYTONA_API_KEY`, and `pnpm add @daytonaio/sdk` |
| `freestyle` | A Freestyle VM | `FREESTYLE_API_KEY`, and `pnpm add freestyle` |

```sh
ORANGE_SANDBOX_PROVIDER=e2b E2B_API_KEY=... pnpm open-orange dev
```

**The `local` provider is not a sandbox.** Commands run on your machine, as
your user, with your tools. Each sandbox is only a directory, by default in
`.open-orange/`. Commands get `PATH`, `LANG`, and `HOME`, but not the other
variables of `open-orange dev`, such as API keys. Use relative paths in
commands: `cat /workspace/a.txt` reads the host's `/workspace`. Never run
untrusted code with it. Use `e2b`, `daytona`, or `freestyle` for that.

Preview URLs work only with the `local` provider. With the others,
`exposePort()` fails and this Worker returns a 500 that names the reason.
A missing API key also fails the first call with a message that names the
variable to set.

`createSession()`, `createCodeContext()`, and `runCode()` are not supported on
OpenOrange, so this example does not use them. See
[Sandbox](../../docs/modules/sandbox.mdx).
