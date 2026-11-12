# `observability.issues` stops `orange dev`

A config with `observability.issues` does not boot. Found on mihaip/infinite-mac, which pins wrangler `^4.137.0` and deploys with this field.

```sh
orange dev
curl http://127.0.0.1:<port>/
```

- Expected: `orange dev` starts (the field has no local effect), and `curl` prints `ok`.
- Actual: `orange dev` exits with code 1: `Unknown Wrangler configuration fields: observability.issues. Remove them or fix their names.`
