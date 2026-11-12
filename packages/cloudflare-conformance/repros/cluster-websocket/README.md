# WebSockets on a cluster

What happens to sockets through a pool URL on a Rivet cluster. `logs/` holds the output of the runs. The runs need a cluster and its credentials, so `record.ts` only reads those logs and writes `result.json`.

```sh
node --import tsx repros/cluster-websocket/record.ts
```

The logs do not show whether an object gets `webSocketClose` during a rollout: the `LASTCLOSE` lines read the reconnect socket's close.
