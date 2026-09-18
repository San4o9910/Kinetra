import React, { useCallback, useEffect, useRef, useState } from 'react';
import type { TrainingPlan, TrainingLesson, TrainingWorkoutInput } from '@kinetra/shared';
import { trainingApi, trainingMessage } from './api';
import { ExerciseEditor } from './ExerciseEditor';
import { draftKey, readDraft, writeDraft, removeDraft } from './drafts';
type Content = { title: string; goal: string; workouts: TrainingWorkoutInput[] };
const clean = (plan: TrainingPlan): Content => ({
  title: plan.title,
  goal: plan.goal,
  workouts: plan.workouts.map(
    ({ id, title, instructions, scheduled_date, duration_minutes, lesson_id, exercises }) => ({
      id,
      title,
      instructions,
      scheduled_date,
      duration_minutes,
      lesson_id,
      exercises: exercises ?? [],
    }),
  ),
});
const valid = (v: Content) =>
  !!v.title.trim() &&
  v.workouts.every(
    (w) =>
      w.title.trim() &&
      w.duration_minutes >= 1 &&
      w.duration_minutes <= 240 &&
      (w.exercises ?? []).every(
        (e) =>
          e.name.trim() &&
          e.sets >= 1 &&
          e.sets <= 20 &&
          (e.repetitions !== null ? e.repetitions >= 1 : e.seconds !== null && e.seconds >= 1),
      ),
  );
const copyWorkout = (w: TrainingWorkoutInput, days = 0): TrainingWorkoutInput => ({
  ...w,
  id: crypto.randomUUID(),
  exercises: (w.exercises ?? []).map((e) => ({ ...e, id: crypto.randomUUID() })),
  scheduled_date: w.scheduled_date
    ? new Date(new Date(w.scheduled_date + 'T12:00:00Z').getTime() + days * 86400000)
        .toISOString()
        .slice(0, 10)
    : null,
});
export const PlanEditor = ({
  plan,
  accountId = '',
  archivedStudent = false,
  lessons,
  onSaved,
}: {
  plan: TrainingPlan;
  accountId?: string;
  archivedStudent?: boolean;
  lessons: TrainingLesson[];
  onSaved: () => void;
}): React.ReactNode => {
  const key = draftKey(accountId, 'plan', plan.id);
  const initial = useRef(clean(plan));
  const stored = useRef(readDraft<{ revision: number; content: Content }>(key));
  const [draft, setDraft] = useState<Content>(() => {
    return stored.current?.content ?? initial.current;
  });
  const [revision, setRevision] = useState(plan.revision),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(
      stored.current && stored.current.revision !== plan.revision
        ? 'На сервере есть более новая версия. Ниже сохранён ваш черновик; скопируйте нужный текст перед загрузкой актуальной программы.'
        : '',
    ),
    [message, setMessage] = useState(''),
    [conflict, setConflict] = useState(
      !!stored.current && stored.current.revision !== plan.revision,
    );
  const [weekStart, setWeekStart] = useState(
    plan.workouts.find((w) => w.scheduled_date)?.scheduled_date ?? '',
  );
  const saved = useRef(JSON.stringify(initial.current)),
    saving = useRef(false),
    current = useRef(draft),
    currentRevision = useRef(revision),
    mounted = useRef(true);
  current.current = draft;
  currentRevision.current = revision;
  const readonly = archivedStudent || plan.status === 'archived',
    serialized = JSON.stringify(draft),
    dirty = serialized !== saved.current;
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  useEffect(() => {
    if (!readonly && dirty && !conflict) writeDraft(key, { revision, content: draft });
  }, [draft, dirty, key, readonly, revision, conflict]);
  useEffect(() => {
    if (!dirty) return;
    const before = (e: BeforeUnloadEvent) => {
      e.preventDefault();
      e.returnValue = '';
    };
    window.addEventListener('beforeunload', before);
    return () => window.removeEventListener('beforeunload', before);
  }, [dirty]);
  const save = useCallback(
    async (publish = false, manual = false) => {
      if (saving.current || readonly || conflict || !valid(current.current)) return false;
      const snapshot = structuredClone(current.current),
        text = JSON.stringify(snapshot);
      saving.current = true;
      setBusy(true);
      setError('');
      try {
        let next = currentRevision.current;
        if (text !== saved.current) {
          const result = await trainingApi.savePlan(plan.id, { ...snapshot, revision: next });
          next = result.revision;
          saved.current = text;
          currentRevision.current = next;
          setRevision(next);
        }
        if (JSON.stringify(current.current) === text) removeDraft(key);
        else writeDraft(key, { revision: next, content: current.current });
        if (publish) {
          await trainingApi.publish(plan.id, next);
          onSaved();
        }
        if (mounted.current)
          setMessage(publish ? 'Программа назначена ученику.' : 'Все изменения сохранены');
        if (manual && !publish && mounted.current) setMessage('Все изменения сохранены');
        return true;
      } catch (e) {
        if (mounted.current) {
          setError(trainingMessage(e));
          if (e && typeof e === 'object' && 'status' in e && e.status === 409) setConflict(true);
        }
        return false;
      } finally {
        saving.current = false;
        if (mounted.current) setBusy(false);
      }
    },
    [conflict, key, onSaved, plan.id, readonly],
  );
  useEffect(() => {
    if (!dirty || readonly || busy || conflict || error || !valid(draft)) return;
    const timer = setTimeout(() => {
      void save();
    }, 1500);
    return () => clearTimeout(timer);
  }, [draft, dirty, readonly, busy, conflict, error, save]);
  const update = (id: string, patch: Partial<TrainingWorkoutInput>) =>
    setDraft((v) => ({
      ...v,
      workouts: v.workouts.map((w) => (w.id === id ? { ...w, ...patch } : w)),
    }));
  const duplicateWeek = () => {
    const source = weekStart
      ? draft.workouts.filter(
          (w) =>
            w.scheduled_date &&
            w.scheduled_date >= weekStart &&
            new Date(w.scheduled_date + 'T12:00:00Z').getTime() <
              new Date(weekStart + 'T12:00:00Z').getTime() + 7 * 86400000,
        )
      : draft.workouts.slice(0, 7);
    if (!source.length) {
      setError('В выбранных семи днях нет занятий.');
      return;
    }
    if (draft.workouts.length + source.length > 100) {
      setError('В программе может быть до 100 занятий.');
      return;
    }
    setDraft((v) => ({ ...v, workouts: [...v.workouts, ...source.map((w) => copyWorkout(w, 7))] }));
  };
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
          {plan.workouts.filter((w) => w.completed_at).length} из {draft.workouts.length} выполнено
        </span>
      </div>
      <form
        className="training-form"
        onSubmit={(e) => {
          e.preventDefault();
          void save(false, true);
        }}
      >
        <fieldset disabled={readonly || busy}>
          <label>
            Название программы
            <input
              required
              maxLength={160}
              value={draft.title}
              onChange={(e) => setDraft((v) => ({ ...v, title: e.target.value }))}
            />
          </label>
          <label>
            Цель и рекомендации
            <textarea
              rows={2}
              maxLength={2000}
              value={draft.goal}
              onChange={(e) => setDraft((v) => ({ ...v, goal: e.target.value }))}
            />
          </label>
        </fieldset>
        {draft.workouts.map((w, index) => {
          const log = plan.workouts.find((old) => old.id === w.id),
            locked = readonly || !!log?.completed_at || !!log?.set_records?.length;
          return (
            <article key={w.id} className="training-workout-editor">
              <div className="training-actions">
                <h3>Занятие {index + 1}</h3>
                {log?.completed_at && (
                  <span className="training-badge">
                    Выполнено {new Date(log.completed_at).toLocaleDateString('ru-RU')}
                  </span>
                )}
                {!readonly && (
                  <button
                    type="button"
                    disabled={busy || draft.workouts.length >= 100}
                    onClick={() =>
                      setDraft((v) => ({ ...v, workouts: [...v.workouts, copyWorkout(w)] }))
                    }
                  >
                    Скопировать занятие
                  </button>
                )}
                {!locked && (
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() =>
                      setDraft((v) => ({ ...v, workouts: v.workouts.filter((x) => x.id !== w.id) }))
                    }
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
                  Инструкции и рекомендации
                  <textarea
                    rows={3}
                    maxLength={5000}
                    value={w.instructions}
                    placeholder="На что обратить внимание во время занятия"
                    onChange={(e) => update(w.id, { instructions: e.target.value })}
                  />
                </label>
                <label>
                  Видеоурок целиком
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
                <ExerciseEditor
                  value={w.exercises ?? []}
                  lessons={lessons}
                  disabled={locked || busy}
                  onChange={(exercises) => update(w.id, { exercises })}
                />
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
              {!!log?.set_records?.length && (
                <div className="training-set-results">
                  <strong>Фактические подходы</strong>
                  {log.set_records.map((r) => (
                    <p key={`${r.exercise_id}:${r.set}`}>
                      {w.exercises?.find((e) => e.id === r.exercise_id)?.name ?? 'Упражнение'} ·
                      подход {r.set}:{' '}
                      {r.repetitions !== null
                        ? `${r.repetitions} повторений`
                        : `${r.seconds ?? 0} сек`}
                      {r.weight_kg !== null ? ` · ${r.weight_kg} кг` : ''} {r.completed ? '✓' : ''}
                    </p>
                  ))}
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
              disabled={busy || draft.workouts.length >= 100}
              onClick={() =>
                setDraft((v) => ({
                  ...v,
                  workouts: [
                    ...v.workouts,
                    {
                      id: crypto.randomUUID(),
                      title: '',
                      instructions: '',
                      scheduled_date: null,
                      duration_minutes: 30,
                      lesson_id: null,
                      exercises: [],
                    },
                  ],
                }))
              }
            >
              ＋ Добавить занятие
            </button>
            <div className="training-copy-week">
              <label>
                Начало недели для копирования
                <input
                  type="date"
                  value={weekStart}
                  onChange={(e) => setWeekStart(e.target.value)}
                />
              </label>
              <button
                type="button"
                disabled={busy || draft.workouts.length === 0}
                onClick={duplicateWeek}
              >
                Скопировать неделю
              </button>
              <small>Копия появится через 7 дней. Без даты копируются первые 7 занятий.</small>
            </div>
            <div className="training-save-bar">
              <span role="status">
                {busy
                  ? 'Сохраняем…'
                  : dirty
                    ? 'Изменения ожидают сохранения'
                    : message || 'Все изменения сохранены'}
              </span>
              <button className="primary-button" disabled={busy || conflict}>
                Сохранить
              </button>
              {plan.status === 'draft' && (
                <button
                  type="button"
                  className="secondary-button"
                  disabled={busy || conflict || !valid(draft) || draft.workouts.length === 0}
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
              <button
                type="button"
                disabled={busy || conflict || !valid(draft) || !draft.workouts.length}
                onClick={() => {
                  void save().then((ok) => {
                    if (ok)
                      void trainingApi
                        .saveTemplate(plan.id)
                        .then(() => setMessage('Шаблон сохранён в вашей библиотеке.'))
                        .catch((e) => setError(trainingMessage(e)));
                  });
                }}
              >
                Сохранить как шаблон
              </button>
            </div>
          </>
        )}
      </form>
      {error && (
        <p role="alert" className="training-error">
          {error}{' '}
          {conflict ? (
            <button
              type="button"
              onClick={() => {
                if (
                  window.confirm(
                    'Загрузить версию с сервера? Несохранённые изменения этой программы будут сброшены.',
                  )
                ) {
                  removeDraft(key);
                  onSaved();
                }
              }}
            >
              Загрузить версию с сервера
            </button>
          ) : (
            <button
              type="button"
              onClick={() => {
                setError('');
                void save(false, true);
              }}
            >
              Повторить сохранение
            </button>
          )}
        </p>
      )}
    </section>
  );
};
