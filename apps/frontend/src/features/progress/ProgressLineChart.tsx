import React, { type ReactNode } from 'react';
import type { WeeklyMetric } from '@kinetra/shared';

import { metricValue, type ProgressMetricConfig } from './model';

export interface ProgressLineChartProps {
  readonly history: readonly WeeklyMetric[];
  readonly metric: ProgressMetricConfig;
}

const chart = Object.freeze({
  width: 360,
  height: 190,
  left: 34,
  right: 14,
  top: 14,
  bottom: 34,
});

const yGridValues = [10, 7, 4, 1] as const;

export const ProgressLineChart = ({ history, metric }: ProgressLineChartProps): ReactNode => {
  const titleId = React.useId();
  const descriptionId = React.useId();
  const points = [...history].sort((left, right) => left.program_week - right.program_week);

  if (points.length < 2) {
    return (
      <p className="progress-chart-empty" data-testid="progress-chart-empty">
        Заполните самооценку минимум за 2 недели, чтобы увидеть динамику
      </p>
    );
  }

  const plotWidth = chart.width - chart.left - chart.right;
  const plotHeight = chart.height - chart.top - chart.bottom;
  const minimumWeek = points[0]?.program_week ?? 1;
  const maximumWeek = points.at(-1)?.program_week ?? minimumWeek;
  const weekSpan = Math.max(1, maximumWeek - minimumWeek);
  const coordinates = points.map((point) => ({
    week: point.program_week,
    value: metricValue(point, metric.key),
    x: chart.left + ((point.program_week - minimumWeek) / weekSpan) * plotWidth,
    y: chart.top + ((10 - metricValue(point, metric.key)) / 9) * plotHeight,
  }));
  const linePoints = coordinates.map(({ x, y }) => `${x.toFixed(2)},${y.toFixed(2)}`).join(' ');
  const description = coordinates
    .map(({ week, value }) => `Неделя ${week}: ${value} из 10`)
    .join('. ');
  const showEvery = points.length > 7 ? 2 : 1;

  return (
    <svg
      className="progress-chart"
      data-testid="progress-chart"
      data-metric={metric.key}
      viewBox={`0 0 ${chart.width} ${chart.height}`}
      role="img"
      aria-labelledby={`${titleId} ${descriptionId}`}
    >
      <title id={titleId}>{`Динамика: ${metric.accessibleLabel}`}</title>
      <desc id={descriptionId}>{description}</desc>

      {yGridValues.map((value) => {
        const y = chart.top + ((10 - value) / 9) * plotHeight;

        return (
          <g key={value} className="progress-chart-grid">
            <line x1={chart.left} x2={chart.width - chart.right} y1={y} y2={y} />
            <text x={chart.left - 8} y={y + 4} textAnchor="end">
              {value}
            </text>
          </g>
        );
      })}

      <polyline
        className="progress-chart-line"
        points={linePoints}
        vectorEffect="non-scaling-stroke"
      />
      {coordinates.map(({ week, value, x, y }, index) => {
        const showLabel =
          index === 0 ||
          index === coordinates.length - 1 ||
          (index < coordinates.length - 2 && index % showEvery === 0);

        return (
          <g key={week}>
            <circle
              className="progress-chart-point"
              data-testid="progress-chart-point"
              cx={x}
              cy={y}
              r="4.5"
              vectorEffect="non-scaling-stroke"
            />
            {showLabel ? (
              <text className="progress-chart-week" x={x} y={chart.height - 9} textAnchor="middle">
                Нед {week}
              </text>
            ) : null}
            <title>{`Неделя ${week}: ${value} из 10`}</title>
          </g>
        );
      })}
    </svg>
  );
};
