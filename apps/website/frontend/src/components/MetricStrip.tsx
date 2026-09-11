import type { Metric } from "../types/marketing";

type MetricStripProps = {
  metrics: Metric[];
};

export const MetricStrip = ({ metrics }: MetricStripProps) => (
  <dl className="metric-strip">
    {metrics.map((metric) => (
      <div className="metric-strip__item" key={metric.label}>
        <dt>{metric.label}</dt>
        <dd>{metric.value}</dd>
      </div>
    ))}
  </dl>
);
