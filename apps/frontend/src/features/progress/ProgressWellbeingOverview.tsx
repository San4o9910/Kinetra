import React, { type ReactNode } from 'react';
import type { WeeklyMetric } from '@kinetra/shared';
import { ProgressBalanceRadar } from './ProgressBalanceRadar';
import { ProgressLineChart } from './ProgressLineChart';
import { progressMetricConfigs } from './model';
import { latestWeeklyMetrics } from './radar';

export const ProgressWellbeingOverview = ({
  history,
}: {
  readonly history: readonly WeeklyMetric[];
}): ReactNode => {
  const [latest, previous] = latestWeeklyMetrics(history);
  return (
    <section
      className="progress-section progress-wellbeing-overview"
      data-testid="progress-wellbeing-overview"
      aria-labelledby="progress-wellbeing-heading"
    >
      <p className="progress-eyebrow">ЧУВСТВОВАТЬ СЕБЯ ЛУЧШЕ</p>
      <div className="progress-section-heading">
        <h2 id="progress-wellbeing-heading">Ваше самочувствие целиком</h2>
        {latest ? (
          <span className="progress-support-copy">Неделя {latest.program_week}</span>
        ) : null}
      </div>
      <p className="progress-support-copy">
        Это описание ваших ответов, а не медицинская оценка. Шкала каждого показателя — от 1 до 10.
      </p>
      {latest ? (
        <React.Fragment>
          <ProgressBalanceRadar metric={latest} />
          <div className="progress-trends">
            {progressMetricConfigs.map((metric) => {
              const delta = previous ? latest[metric.key] - previous[metric.key] : null;
              return (
                <article className="progress-trend" key={metric.key}>
                  <div className="progress-trend-heading">
                    <h3>{metric.accessibleLabel}</h3>
                    <strong>
                      {latest[metric.key]}
                      <span> / 10</span>
                    </strong>
                  </div>
                  <p className="progress-trend-comparison">
                    {delta === null
                      ? 'Первая самооценка'
                      : `${delta > 0 ? '+' : ''}${delta} к неделе ${previous?.program_week}`}
                  </p>
                  <ProgressLineChart
                    history={history}
                    metric={metric}
                    testIdPrefix={`trend-${metric.key}-chart`}
                  />
                </article>
              );
            })}
          </div>
        </React.Fragment>
      ) : (
        <p className="progress-chart-empty" data-testid="progress-radar-empty">
          После первой самооценки здесь появится картина вашего самочувствия.
        </p>
      )}
    </section>
  );
};
