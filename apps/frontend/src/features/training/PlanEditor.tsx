import React, { useState } from 'react';
import type { TrainingPlan, TrainingLesson, TrainingWorkoutInput } from '@kinetra/shared';
import { trainingApi, trainingMessage } from './api';
export const PlanEditor = ({
  plan,
  archivedStudent = false,
  lessons,
  onSaved,
}: {
  plan: TrainingPlan;
  archivedStudent?: boolean;
  lessons: TrainingLesson[];
  onSaved: () => void;
}): React.ReactNode => {
  const [title, setTitle] = useState(plan.title);
  const [goal, setGoal] = useState(plan.goal);
  const [workouts, setWorkouts] = useState<TrainingWorkoutInput[]>(
    plan.workouts.map(
      ({ id, title, instructions, scheduled_date, duration_minutes, lesson_id }) => ({
        id,
        title,
        instructions,
        scheduled_date,
        duration_minutes,
        lesson_id,
      }),
    ),
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');
  const readonly = archivedStudent || plan.status === 'archived';
  const update = (id: string, patch: Partial<TrainingWorkoutInput>) =>
    setWorkouts((items) => items.map((w) => (w.id === id ? { ...w, ...patch } : w)));
  const save = async (publish: boolean) => {
    if (busy) return;
    setBusy(true);
    setError('');
    try {
      const result = await trainingApi.savePlan(plan.id, {
        title,
        goal,
        revision: plan.revision,
        workouts,
      });
      if (publish) await trainingApi.publish(plan.id, result.revision);
      setMessage(publish ? 'Программа назначена ученику.' : 'Изменения сохранены.');
      onSaved();
    } catch (e) {
      setError(trainingMessage(e));
    } finally {
      setBusy(false);
    }
  };
  const completed = plan.workouts.filter((w) => w.completed_at).length;
  return (
    <section className="training-card training-plan" aria-label={`Программа ${plan.title}`}>
      <div className="training-actions">
        <span className="training-badge">
          {plan.status === 'draft'
            ? 'Черновик · виден только вам'
            : plan.status === 'published'
              ? 'Назначена ученику'
              : 'Архив'}
        </span>
        <span>
          {completed} из {plan.workouts.length} выполнено
        </span>
      </div>
      <form
        className="training-form"
        onSubmit={(e) => {
          e.preventDefault();
          void save(false);
        }}
      >
        <fieldset disabled={readonly || busy}>
          <label>
            Название программы
            <input
              required
              maxLength={160}
              value={title}
              onChange={(e) => setTitle(e.target.value)}
            />
          </label>
          <label>
            Цель и рекомендации
            <textarea
              rows={2}
              maxLength={2000}
              value={goal}
              onChange={(e) => setGoal(e.target.value)}
            />
          </label>
        </fieldset>
        {workouts.map((w, index) => {
          const log = plan.workouts.find((old) => old.id === w.id);
          const locked = readonly || !!log?.completed_at;
          return (
            <article key={w.id} className="training-workout-editor">
              <div className="training-actions">
                <h3>Занятие {index + 1}</h3>
                {log?.completed_at && (
                  <span className="training-badge">
                    Выполнено {new Date(log.completed_at).toLocaleDateString('ru-RU')}
                  </span>
                )}
                {!locked && (
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() => setWorkouts((items) => items.filter((item) => item.id !== w.id))}
                  >
                    Убрать
                  </button>
                )}
              </div>
              <fieldset disabled={locked || busy}>
                <label>
                  Название занятия
                  <input
                    required
                    maxLength={160}
                    value={w.title}
                    onChange={(e) => update(w.id, { title: e.target.value })}
                  />
                </label>
                <div className="training-fields">
                  <label>
                    Дата
                    <input
                      type="date"
                      value={w.scheduled_date ?? ''}
                      onChange={(e) => update(w.id, { scheduled_date: e.target.value || null })}
                    />
                  </label>
                  <label>
                    Продолжительность, мин
                    <input
                      type="number"
                      min={1}
                      max={240}
                      required
                      value={w.duration_minutes}
                      onChange={(e) => update(w.id, { duration_minutes: Number(e.target.value) })}
                    />
                  </label>
                </div>
                <label>
                  Упражнения, подходы и повторения
                  <textarea
                    rows={3}
                    maxLength={5000}
                    value={w.instructions}
                    placeholder="Например: приседания — 3 подхода по 12 повторений. Отдых — 60 секунд."
                    onChange={(e) => update(w.id, { instructions: e.target.value })}
                  />
                </label>
                <label>
                  Видеоурок
                  <select
                    value={w.lesson_id ?? ''}
                    onChange={(e) => update(w.id, { lesson_id: e.target.value || null })}
                  >
                    <option value="">Без видео</option>
                    {lessons
                      .filter((l) => l.status === 'ready')
                      .map((l) => (
                        <option key={l.id} value={l.id}>
                          {l.title}
                        </option>
                      ))}
                  </select>
                </label>
              </fieldset>
              {log?.completed_at && (
                <div className="training-feedback">
                  <strong>Обратная связь ученика</strong>
                  <p>
                    Сложность: {log.difficulty ?? '—'} / 5 · Самочувствие: {log.wellbeing ?? '—'} /
                    5
                  </p>
                  {log.note && <p>{log.note}</p>}
                </div>
              )}
            </article>
          );
        })}
        {!readonly && (
          <>
            <button
              type="button"
              className="secondary-button"
              disabled={busy || workouts.length >= 100}
              onClick={() =>
                setWorkouts((items) => [
                  ...items,
                  {
                    id: crypto.randomUUID(),
                    title: '',
                    instructions: '',
                    scheduled_date: null,
                    duration_minutes: 30,
                    lesson_id: null,
                  },
                ])
              }
            >
              ＋ Добавить занятие
            </button>
            <p className="training-muted">
              Дата необязательна. Выполненные занятия сохраняются без изменений.
            </p>
            <div className="training-actions">
              <button className="primary-button" disabled={busy}>
                {busy ? 'Сохраняем…' : 'Сохранить'}
              </button>
              {plan.status === 'draft' && (
                <button
                  type="button"
                  className="secondary-button"
                  disabled={
                    busy ||
                    workouts.length === 0 ||
                    !title.trim() ||
                    workouts.some((w) => !w.title.trim())
                  }
                  onClick={() => {
                    if (
                      window.confirm(
                        'Назначить программу ученику? Предыдущая программа останется в истории.',
                      )
                    )
                      void save(true);
                  }}
                >
                  Сохранить и назначить
                </button>
              )}
            </div>
          </>
        )}
      </form>
      {error && (
        <p role="alert" className="training-error">
          {error}
        </p>
      )}
      {message && <p role="status">{message}</p>}
    </section>
  );
};
