# Memory of keeping objects awake for WebSockets

What an idle object and an idle socket cost while an object stays awake with an open accepted WebSocket. `measure.mjs` runs real `orange serve` against a standalone Engine, with idle `ws` clients, and reads RSS and PSS from `/proc`. `readings.csv` holds the readings from 4 runs on one machine, on `96efb7b6`.

A run takes about 20 minutes on a quiet Linux machine, so `record.ts` only reads the CSV and writes `result.json`.

```sh
node --import tsx repros/keep-awake-memory/record.ts
```

- 1,000 sockets read high right after they open: 622 MB in Orange at 75 s and 491 MB about 6 minutes later, in the same run. The socket figure uses the later reading.
- Objects hold no real state, and sockets carry no traffic, so these are idle floors.
- Standard `accept()` sockets and a run with pings off were not measured.
