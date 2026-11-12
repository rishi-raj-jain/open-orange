# Sandbox (1.x API)

A sandbox per name, built on `@cloudflare/sandbox` 1.x. The `Sandbox` Durable
Object starts its own Container with `ctx.container`, runs commands with
`container.exec()`, and reads and writes files with `Files`. It has no
OpenOrange imports. For the 0.x `getSandbox()` API, see `../sandbox`.

## What it shows

- `env.SANDBOX.getByName(name)`: one sandbox per name.
- `ctx.container.start()` and `container.exec(argv, { cwd })`. A command that
  fails returns its `exitCode` and `stderr`; it is not an HTTP error.
- `new Files(container)` with `writeFile()` and `readFile()`. A missing file is
  a `SandboxFileError` with code `ENOENT`, returned as a 404.
- `container.destroy()`. The next call gets a new, empty sandbox.

## Run it

From this directory:

```sh
pnpm open-orange dev
```

`wrangler dev` needs Docker for the image in `Dockerfile`. `open-orange dev`
does not. It runs the container on the provider that `ORANGE_SANDBOX_PROVIDER`
picks, which runs only Cloudflare Sandbox images.

## Try it

```sh
S=localhost:8787/sandboxes/ada

curl -X POST $S/exec -d '{"argv":["sh","-c","echo hi; exit 3"]}'   # 200, exitCode 3
curl -X PUT $S/files/notes.txt -d 'ship it'                          # 204
curl $S/files/notes.txt
curl $S/files/missing.txt                                            # 404
curl -X DELETE $S                                                    # 204
```
