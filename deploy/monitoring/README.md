# Monitoring EPM (NFR12)

Each backend serves `/metrics` in the Prometheus text format: request counts and latency by
route, calls to OpenProject by outcome and duration, memory and event-loop delay, and — read
from the database at scrape time, so every backend reports the same — the email outbox, the
rule queue, the last analytics refresh, failed report runs and which scheduled jobs are running.

## Switching it on

1. Generate a token: `openssl rand -hex 24`.
2. Give it to the backend as `EPM_METRICS_TOKEN` (or `EPM_METRICS_TOKEN_FILE` pointing at a
   secret file). Unset, `/metrics` answers 404.
3. Give the same token to the scraper. A request without it gets 401.

`/metrics` is not routed by Caddy, so it is never reachable from the internet. The scraper reaches
each backend on the internal network (`backend:8000` in the compose files); a scraper elsewhere
needs the backend port published on a private interface.

## Prometheus

```yaml
scrape_configs:
  - job_name: epm-backend
    metrics_path: /metrics
    scrape_interval: 30s
    authorization:
      type: Bearer
      credentials_file: /etc/prometheus/epm-metrics-token
    static_configs:
      - targets: ['backend:8000']

rule_files:
  - /etc/prometheus/epm-alerts.yml
```

`epm-alerts.yml` here holds the alerting rules: a backend or a dependency down, the 95th
percentile over NFR01's 2 seconds, server errors, OpenProject failing, email backlog and give-ups,
a stuck rule queue, stale dashboards, failed scheduled reports, and a blocked event loop. Each
says what to check first.

Other monitoring platforms (Grafana Agent, Datadog, Azure Monitor, Elastic) read the same format;
point their Prometheus integration at the same endpoint with the same token.

## Logs

Request logs are JSON in production (`NODE_ENV=production`), one line per request with
`reqId`, `route` (the pattern, e.g. `/api/projects/:id`), `userId` once signed in, the status code
and `responseTime`. Credentials, cookies and passwords are redacted before a line is written.
Ship the container's stdout to the central log store.
