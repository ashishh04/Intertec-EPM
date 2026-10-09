import { monitorEventLoopDelay } from 'node:perf_hooks';

/**
 * Metrics in the Prometheus text format (NFR12), for whatever monitoring the
 * client runs to scrape — Prometheus, Grafana Agent, Datadog, Azure Monitor
 * all read it. Written by hand, like the PDF and workbook writers: the format
 * is a few lines of text, and a dependency for it would be one more thing to
 * patch.
 *
 * Process-local, as a scrape expects: each server is scraped on its own and
 * the monitoring sums them. What only the database knows — the outbox, the
 * rule queue, the last analytics refresh — is read at scrape time instead
 * (`routes/metrics.ts`), so every server reports the same shared truth.
 */

type Labels = Record<string, string>;

const key = (labels: Labels) =>
  Object.keys(labels)
    .sort()
    .map((name) => `${name}=${JSON.stringify(labels[name])}`)
    .join(',');

class Counter {
  private readonly values = new Map<string, { labels: Labels; value: number }>();
  constructor(readonly name: string, readonly help: string) {}
  inc(labels: Labels = {}, by = 1): void {
    const id = key(labels);
    const entry = this.values.get(id) ?? { labels, value: 0 };
    entry.value += by;
    this.values.set(id, entry);
  }
  render(): string[] {
    const lines = [`# HELP ${this.name} ${this.help}`, `# TYPE ${this.name} counter`];
    for (const { labels, value } of this.values.values()) lines.push(`${this.name}${braces(labels)} ${value}`);
    return lines;
  }
}

class Histogram {
  private readonly series = new Map<string, { labels: Labels; counts: number[]; sum: number; count: number }>();
  constructor(readonly name: string, readonly help: string, readonly buckets: number[]) {}
  observe(labels: Labels, seconds: number): void {
    const id = key(labels);
    const entry = this.series.get(id) ?? { labels, counts: this.buckets.map(() => 0), sum: 0, count: 0 };
    this.buckets.forEach((bound, index) => {
      if (seconds <= bound) entry.counts[index]! += 1;
    });
    entry.sum += seconds;
    entry.count += 1;
    this.series.set(id, entry);
  }
  render(): string[] {
    const lines = [`# HELP ${this.name} ${this.help}`, `# TYPE ${this.name} histogram`];
    for (const { labels, counts, sum, count } of this.series.values()) {
      this.buckets.forEach((bound, index) =>
        lines.push(`${this.name}_bucket${braces({ ...labels, le: String(bound) })} ${counts[index]}`),
      );
      lines.push(`${this.name}_bucket${braces({ ...labels, le: '+Inf' })} ${count}`);
      lines.push(`${this.name}_sum${braces(labels)} ${round(sum)}`);
      lines.push(`${this.name}_count${braces(labels)} ${count}`);
    }
    return lines;
  }
}

function braces(labels: Labels): string {
  const inner = key(labels);
  return inner ? `{${inner}}` : '';
}

const round = (value: number) => Math.round(value * 1e6) / 1e6;

/** Seconds. NFR01's target is 2 s at p95, so the buckets are fine around it. */
const LATENCY = [0.05, 0.1, 0.25, 0.5, 1, 2, 3, 5, 10, 30];

export const httpRequests = new Counter('epm_http_requests_total', 'API requests answered, by route and status class.');
export const httpDuration = new Histogram(
  'epm_http_request_duration_seconds',
  'Time to answer an API request, by route.',
  LATENCY,
);
export const upstreamRequests = new Counter(
  'epm_openproject_requests_total',
  'Calls to OpenProject, by method and outcome (status class, error or timeout).',
);
export const upstreamDuration = new Histogram(
  'epm_openproject_request_duration_seconds',
  'Time OpenProject took to answer, per attempt.',
  LATENCY,
);

/** HTTP status as a class, so the label set stays small: 2xx, 4xx, 5xx. */
export const statusClass = (status: number) => (status === 0 ? 'error' : `${Math.floor(status / 100)}xx`);

export function observeUpstream(method: string, outcome: string, seconds: number): void {
  upstreamRequests.inc({ method, outcome });
  upstreamDuration.observe({ method }, seconds);
}

const loopDelay = monitorEventLoopDelay({ resolution: 20 });
loopDelay.enable();
const startedAt = Date.now();

/** Everything this process knows, as text lines. */
export function renderProcessMetrics(): string[] {
  const memory = process.memoryUsage();
  const lines = [
    ...httpRequests.render(),
    ...httpDuration.render(),
    ...upstreamRequests.render(),
    ...upstreamDuration.render(),
    '# HELP epm_process_uptime_seconds Seconds since this server started.',
    '# TYPE epm_process_uptime_seconds gauge',
    `epm_process_uptime_seconds ${Math.round((Date.now() - startedAt) / 1000)}`,
    '# HELP epm_process_resident_memory_bytes Resident memory of this server.',
    '# TYPE epm_process_resident_memory_bytes gauge',
    `epm_process_resident_memory_bytes ${memory.rss}`,
    '# HELP epm_process_heap_used_bytes JavaScript heap in use.',
    '# TYPE epm_process_heap_used_bytes gauge',
    `epm_process_heap_used_bytes ${memory.heapUsed}`,
    '# HELP epm_event_loop_delay_p99_seconds How late the event loop ran timers, 99th percentile since the last scrape.',
    '# TYPE epm_event_loop_delay_p99_seconds gauge',
    `epm_event_loop_delay_p99_seconds ${round(loopDelay.percentile(99) / 1e9)}`,
  ];
  loopDelay.reset();
  return lines;
}
