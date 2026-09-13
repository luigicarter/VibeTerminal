type LogFields = {
  requestId?: string;
  route?: string;
  status?: number;
  durationMs?: number;
  count?: number;
};
export function log(
  level: 'info' | 'warn' | 'error',
  event: string,
  fields: LogFields = {},
) {
  // Call sites provide fixed event/route names, never caught messages or request payloads.
  console.log(
    JSON.stringify({ time: new Date().toISOString(), level, event, ...fields }),
  );
}
export class Metrics {
  requests = 0;
  errors = 0;
  durations: number[] = [];
  record(status: number, ms: number) {
    this.requests++;
    if (status >= 500) this.errors++;
    this.durations.push(ms);
    if (this.durations.length > 1000) this.durations.shift();
  }
  text() {
    const sorted = [...this.durations].sort((a, b) => a - b);
    return `lina_requests_total ${this.requests}\nlina_errors_total ${this.errors}\nlina_request_p95_ms ${sorted[Math.floor(sorted.length * 0.95)] || 0}\nlina_rss_bytes ${process.memoryUsage().rss}\nlina_uptime_seconds ${process.uptime()}\n`;
  }
}
