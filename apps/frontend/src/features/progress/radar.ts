import type { WeeklyMetric } from '@kinetra/shared';
import { progressMetricConfigs } from './model';

export const latestWeeklyMetrics = (history: readonly WeeklyMetric[]): readonly WeeklyMetric[] =>
  [...history].sort((left, right) => right.program_week - left.program_week).slice(0, 2);

export const radarPoint = (
  index: number,
  score: number,
): { readonly x: number; readonly y: number } => {
  const clamped = Number.isFinite(score) ? Math.min(10, Math.max(0, score)) : 0;
  const angle = (index * Math.PI) / 2 - Math.PI / 2;
  return { x: 180 + Math.cos(angle) * clamped * 9, y: 150 + Math.sin(angle) * clamped * 9 };
};

export const radarPolygon = (metric: WeeklyMetric): string =>
  progressMetricConfigs
    .map(({ key }, index) => {
      const point = radarPoint(index, metric[key]);
      return `${point.x.toFixed(2)},${point.y.toFixed(2)}`;
    })
    .join(' ');
