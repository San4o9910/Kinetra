import React, { type ReactNode } from 'react';
import type { WeeklyMetric } from '@kinetra/shared';
import { progressMetricConfigs } from './model';
import { radarPoint, radarPolygon } from './radar';

export const ProgressBalanceRadar = ({ metric }: { readonly metric: WeeklyMetric }): ReactNode => {
  const titleId = React.useId();
  const descriptionId = React.useId();
  const grid = (score: number): string =>
    progressMetricConfigs
      .map((_, index) => {
        const point = radarPoint(index, score);
        return `${point.x},${point.y}`;
      })
      .join(' ');
  return (
    <div className="progress-radar-wrap">
      <svg
        className="progress-radar"
        data-testid="progress-radar"
        viewBox="0 0 360 300"
        role="img"
        aria-labelledby={`${titleId} ${descriptionId}`}
      >
        <title id={titleId}>{`Самооценка за неделю ${metric.program_week}`}</title>
        <desc id={descriptionId}>
          {progressMetricConfigs
            .map(({ accessibleLabel, key }) => `${accessibleLabel}: ${metric[key]} из 10`)
            .join('. ')}
        </desc>
        {[2, 4, 6, 8, 10].map((score) => (
          <polygon key={score} className="progress-radar-grid" points={grid(score)} />
        ))}
        {progressMetricConfigs.map((_, index) => {
          const point = radarPoint(index, 10);
          return (
            <line
              className="progress-radar-axis"
              key={index}
              x1="180"
              y1="150"
              x2={point.x}
              y2={point.y}
            />
          );
        })}
        <polygon className="progress-radar-shape" points={radarPolygon(metric)} />
        {progressMetricConfigs.map(({ key }, index) => {
          const point = radarPoint(index, metric[key]);
          return (
            <circle key={key} className="progress-radar-point" cx={point.x} cy={point.y} r="4" />
          );
        })}
        <g className="progress-radar-labels" textAnchor="middle">
          <text x="180" y="35">
            Энергия
          </text>
          <text x="314" y="155">
            Сон
          </text>
          <text x="180" y="277">
            Настроение
          </text>
          <text x="42" y="155">
            Тело
          </text>
        </g>
      </svg>
      <dl className="progress-radar-values">
        {progressMetricConfigs.map(({ key, accessibleLabel }) => (
          <div key={key}>
            <dt>{accessibleLabel}</dt>
            <dd>
              {metric[key]}
              <span> / 10</span>
            </dd>
          </div>
        ))}
      </dl>
    </div>
  );
};
