import React from 'react';
import { useEffect, useState } from 'react';
import type { TrainerClientContext } from '@kinetra/shared';
import { getTrainerClientContext } from '../../lib/api';

export const TrainerClientSummary = ({
  conversationId,
}: {
  readonly conversationId: string;
}): React.ReactNode => {
  const [data, setData] = useState<TrainerClientContext | null>(null);
  const [error, setError] = useState(false);
  const [revision, setRevision] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    void getTrainerClientContext(conversationId, controller.signal)
      .then((value) => {
        if (!controller.signal.aborted) {
          setData(value);
          setError(false);
        }
      })
      .catch(() => {
        if (!controller.signal.aborted) {
          setError(true);
          setData(null);
        }
      });
    return () => controller.abort();
  }, [conversationId, revision]);
  return (
    <details className="trainer-client-summary">
      <summary>Прогресс и отметки клиента</summary>
      {error ? (
        <p role="status">
          Данные не загрузились.{' '}
          <button type="button" onClick={() => setRevision((value) => value + 1)}>
            Повторить
          </button>
        </p>
      ) : data === null ? (
        <p role="status">Загружаем…</p>
      ) : (
        <>
          <div className="trainer-client-stats">
            <span>
              Неделя <strong>{data.progress.metrics.current_week} / 12</strong>
            </span>
            <span>
              Занятий <strong>{data.progress.stats.total_workouts}</strong>
            </span>
            <span>
              Время <strong>{data.progress.stats.total_minutes_trained} мин</strong>
            </span>
          </div>
          <p>{data.progress.goal.goal_label}</p>
          {data.recent_sessions.length === 0 ? (
            <p>Отметок после тренировок пока нет.</p>
          ) : (
            data.recent_sessions.map((session, index) => (
              <article key={`${session.updated_at}:${index}`}>
                <strong>{session.title}</strong>
                <p>
                  Сложность: {session.difficulty ?? '—'} / 5 · Самочувствие:{' '}
                  {session.wellbeing ?? '—'} / 5
                </p>
                {session.note && <p>{session.note}</p>}
              </article>
            ))
          )}
        </>
      )}
    </details>
  );
};
