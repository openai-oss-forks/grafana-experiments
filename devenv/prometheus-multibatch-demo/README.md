# Prometheus Multi-Batch Demo Backend

This local backend mimics a Chronosphere-compatible Prometheus `query_range` endpoint and streams one HTTP response as two `application/prometheus.multibatch` frames.

Run it from the Grafana repo root:

```bash
go run ./devenv/prometheus-multibatch-demo
```

The server listens on `:19090` by default. Grafana dev provisioning includes a `Chronosphere Multibatch Demo` Prometheus datasource with UID `chronosphere-multibatch-demo` and a `Prometheus Multi-Batch Streaming Demo` dashboard.

Behavior:

- `POST /api/v1/query_range` returns the first half of the requested range immediately.
- The server waits 10 seconds.
- The final frame returns the second half of the range and sets the final-batch flag.
- Each frame payload is zstd-compressed JSONL containing a normal Prometheus matrix API response.

Environment variables:

- `PROMETHEUS_MULTIBATCH_DEMO_ADDR`, default `:19090`
- `PROMETHEUS_MULTIBATCH_DEMO_DELAY`, default `10s`
