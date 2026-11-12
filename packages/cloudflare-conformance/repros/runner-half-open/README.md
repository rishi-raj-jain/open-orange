# A runner whose Engine connection goes half-open never reconnects

A TCP proxy sits between `orange serve` and a local Engine. Once the runner registers, the proxy either closes its sockets (the control) or stops forwarding on them and leaves them open (the fault). New connections keep working in both cases.

```sh
node --import tsx repros/runner-half-open/run.ts   # from packages/cloudflare-conformance, after pnpm build at the root
```

- Expected: the runner reconnects in both cases, and a Durable Object call returns 200.
- Actual: after a close it reconnects. After the fault its node stays gone, it logs nothing about the connection, and the Durable Object call fails.

The owner is the envoy client in RivetKit: its read loop has no deadline, so nothing notices silence while connected. This reproduces locally. An outage on a Rivet cluster had matching symptoms, but that is not proven to be this fault.

`run.ts` writes `result.json`, which the truth table reads.
