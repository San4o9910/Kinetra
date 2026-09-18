import { useCallback, useEffect, useRef, useState } from 'react';
import type { TrainingWorkout, TrainingSetRecord } from '@kinetra/shared';
import { trainingApi, trainingMessage } from './api';
import { TrainingPlayer } from './TrainingPlayer';
import { draftKey, readDraft, writeDraft, removeDraft } from './drafts';
import { prepareExerciseQuestion } from '../program/workoutQuestion';
type SessionDraft = {
  records: TrainingSetRecord[];
  difficulty: number;
  wellbeing: number;
  note: string;
  completed: boolean;
  revision: number;
  pending: boolean;
};
export const WorkoutSession = ({
  workout,
  accountId,
  onClose,
  onSaved,
  onChat,
}: {
  workout: TrainingWorkout;
  accountId: string;
  onClose: () => void;
  onSaved: () => void;
  onChat: () => void;
}) => {
  const key = draftKey(accountId, 'workout', workout.id);
  const [value, setValue] = useState<SessionDraft>(
    () =>
      readDraft<SessionDraft>(key) ?? {
        records: workout.set_records ?? [],
        difficulty: workout.difficulty ?? 3,
        wellbeing: workout.wellbeing ?? 3,
        note: workout.note,
        completed: !!workout.completed_at,
        revision: workout.progress_revision ?? 0,
        pending: false,
      },
  );
  const [index, setIndex] = useState(0),
    [remaining, setRemaining] = useState(0),
    [restEnd, setRestEnd] = useState<number | null>(null),
    [busy, setBusy] = useState(false),
    [status, setStatus] = useState(''),
    [error, setError] = useState(''),
    [conflict, setConflict] = useState(false);
  const state = useRef(value),
    running = useRef(false),
    active = useRef(true);
  state.current = value;
  const exercises = workout.exercises ?? [],
    exercise = exercises[index];
  useEffect(() => {
    active.current = true;
    return () => {
      active.current = false;
    };
  }, []);
  const persist = (next: SessionDraft) => {
    state.current = next;
    setValue(next);
    if (!writeDraft(key, next))
      setStatus(
        'Браузер не разрешил сохранить черновик. Не закрывайте тренировку до отправки отметок.',
      );
  };
  const flush = useCallback(async () => {
    if (running.current || !state.current.pending || conflict) return;
    if (typeof navigator !== 'undefined' && !navigator.onLine) {
      setStatus('Нет связи. Отметки сохранены на этом устройстве.');
      return;
    }
    const snapshot = structuredClone(state.current);
    running.current = true;
    setBusy(true);
    setError('');
    try {
      const result = await trainingApi.log(workout.id, {
        set_records: snapshot.records,
        difficulty: snapshot.difficulty,
        wellbeing: snapshot.wellbeing,
        note: snapshot.note,
        base_revision: snapshot.revision,
        ...(snapshot.completed ? { completed: true as const } : {}),
      });
      const next = {
        ...state.current,
        revision: result.revision ?? snapshot.revision + 1,
        pending: JSON.stringify(state.current) !== JSON.stringify(snapshot),
      };
      state.current = next;
      if (next.pending) writeDraft(key, next);
      else removeDraft(key);
      if (active.current) {
        setValue(next);
        setStatus('Сохранено у тренера');
        if (snapshot.completed && !next.pending) onSaved();
      }
    } catch (e) {
      if (active.current) {
        setError(trainingMessage(e));
        if (e && typeof e === 'object' && 'status' in e && e.status === 409) setConflict(true);
        else setStatus('Отметки ожидают отправки.');
      }
    } finally {
      running.current = false;
      if (active.current) setBusy(false);
    }
  }, [conflict, key, onSaved, workout.id]);
  useEffect(() => {
    const online = () => {
      void flush();
    };
    window.addEventListener('online', online);
    return () => window.removeEventListener('online', online);
  }, [flush]);
  useEffect(() => {
    if (!value.pending || busy || conflict || error) return;
    const timer = setTimeout(() => {
      void flush();
    }, 650);
    return () => clearTimeout(timer);
  }, [value, busy, conflict, error, flush]);
  useEffect(() => {
    if (restEnd === null) return;
    const tick = () => setRemaining(Math.max(0, Math.ceil((restEnd - Date.now()) / 1000)));
    tick();
    const timer = setInterval(tick, 250);
    return () => clearInterval(timer);
  }, [restEnd]);
  useEffect(() => {
    if (!value.pending) return;
    const before = (e: BeforeUnloadEvent) => {
      e.preventDefault();
      e.returnValue = '';
    };
    window.addEventListener('beforeunload', before);
    return () => window.removeEventListener('beforeunload', before);
  }, [value.pending]);
  const record = (set: number) =>
    value.records.find((r) => r.exercise_id === exercise?.id && r.set === set) ?? {
      exercise_id: exercise!.id,
      set,
      repetitions: exercise!.repetitions,
      seconds: exercise!.seconds,
      weight_kg: exercise!.weight_kg,
      completed: false,
    };
  const updateRecord = (set: number, patch: Partial<TrainingSetRecord>) => {
    const r = { ...record(set), ...patch };
    persist({
      ...state.current,
      pending: true,
      records: [
        ...state.current.records.filter((v) => v.exercise_id !== r.exercise_id || v.set !== set),
        r,
      ],
    });
    if (patch.completed && exercise) {
      setRestEnd(Date.now() + exercise.rest_seconds * 1000);
    }
  };
  const change = (patch: Partial<SessionDraft>) =>
    persist({ ...state.current, ...patch, pending: true });
  return (
    <section
      className="training-session training-card"
      aria-label="Режим тренировки"
      data-testid="training-session"
    >
      <div className="training-heading">
        <div>
          <p className="survey-kicker">ВАША ТРЕНИРОВКА</p>
          <h2>{workout.title}</h2>
        </div>
        <button
          type="button"
          onClick={() => {
            if (
              !value.pending ||
              window.confirm('Отметки остаются на этом устройстве. Вернуться к программе?')
            )
              onClose();
          }}
        >
          К программе
        </button>
      </div>
      {!!exercises.length && (
        <>
          <div className="training-actions">
            <span className="training-badge">
              Упражнение {index + 1} / {exercises.length}
            </span>
            <span>{value.records.filter((r) => r.completed).length} подходов выполнено</span>
          </div>
          <progress
            aria-label="Выполненные подходы"
            max={Math.max(
              1,
              exercises.reduce((sum, e) => sum + e.sets, 0),
            )}
            value={value.records.filter((r) => r.completed).length}
          />
        </>
      )}
      {exercise ? (
        <>
          <h3 className="training-session-title">{exercise.name}</h3>
          <p>
            {exercise.sets} подхода ·{' '}
            {exercise.repetitions !== null
              ? `${exercise.repetitions} повторений`
              : `${exercise.seconds} секунд`}
            {exercise.weight_kg !== null ? ` · ${exercise.weight_kg} кг` : ''}
          </p>
          {exercise.lesson_id && (
            <TrainingPlayer
              key={exercise.lesson_id}
              id={exercise.lesson_id}
              title={exercise.name}
            />
          )}
          <div className="training-set-list">
            {Array.from({ length: exercise.sets }, (_, i) => i + 1).map((n) => {
              const r = record(n);
              return (
                <fieldset key={`${exercise.id}:${n}`} disabled={busy || conflict}>
                  <legend>Подход {n}</legend>
                  <div className="training-fields">
                    <label>
                      {exercise.repetitions !== null ? 'Повторений' : 'Секунд'}
                      <input
                        type="number"
                        min={0}
                        max={exercise.repetitions !== null ? 1000 : 7200}
                        value={
                          exercise.repetitions !== null ? (r.repetitions ?? '') : (r.seconds ?? '')
                        }
                        onChange={(e) =>
                          updateRecord(
                            n,
                            exercise.repetitions !== null
                              ? { repetitions: Number(e.target.value) }
                              : { seconds: Number(e.target.value) },
                          )
                        }
                      />
                    </label>
                    <label>
                      Вес, кг
                      <input
                        type="number"
                        min={0}
                        max={1000}
                        step="0.5"
                        value={r.weight_kg ?? ''}
                        onChange={(e) =>
                          updateRecord(n, {
                            weight_kg: e.target.value === '' ? null : Number(e.target.value),
                          })
                        }
                      />
                    </label>
                    <button
                      className={r.completed ? 'training-done' : 'primary-button'}
                      type="button"
                      aria-pressed={r.completed}
                      onClick={() => updateRecord(n, { completed: !r.completed })}
                    >
                      {r.completed ? '✓ Выполнено' : 'Готово'}
                    </button>
                  </div>
                </fieldset>
              );
            })}
          </div>
          {restEnd !== null && (
            <div className="training-rest" role="timer" aria-label="Таймер отдыха">
              <span>{remaining > 0 ? 'Отдых' : 'Можно продолжать'}</span>
              <strong>
                {Math.floor(remaining / 60)}:{String(remaining % 60).padStart(2, '0')}
              </strong>
              <button
                type="button"
                onClick={() => {
                  setRestEnd(null);
                  setRemaining(0);
                }}
              >
                Завершить отдых
              </button>
            </div>
          )}
          <div className="training-actions">
            <button type="button" disabled={index === 0} onClick={() => setIndex((i) => i - 1)}>
              ← Назад
            </button>
            <button
              type="button"
              disabled={index === exercises.length - 1}
              onClick={() => setIndex((i) => i + 1)}
            >
              Следующее упражнение →
            </button>
            <button
              type="button"
              onClick={() => {
                prepareExerciseQuestion(accountId, workout.title, exercise.name);
                onChat();
              }}
            >
              Вопрос тренеру
            </button>
          </div>
        </>
      ) : (
        <>
          <p className="training-instructions">{workout.instructions}</p>
          {workout.lesson_id && (
            <TrainingPlayer
              id={workout.lesson_id}
              title={workout.title}
              position={workout.position_seconds}
              onPosition={(seconds) => {
                void trainingApi
                  .log(workout.id, { position_seconds: seconds })
                  .catch(() => undefined);
              }}
            />
          )}
        </>
      )}
      <form
        className="training-form"
        onSubmit={(e) => {
          e.preventDefault();
          change({ completed: true });
        }}
      >
        <h3>Как прошло занятие?</h3>
        <fieldset disabled={busy || conflict}>
          <div className="training-fields">
            <label>
              Сложность, от 1 до 5
              <select
                value={value.difficulty}
                onChange={(e) => change({ difficulty: Number(e.target.value) })}
              >
                {[1, 2, 3, 4, 5].map((n) => (
                  <option key={n} value={n}>
                    {n}
                    {n === 1 ? ' — легко' : n === 5 ? ' — очень сложно' : ''}
                  </option>
                ))}
              </select>
            </label>
            <label>
              Самочувствие, от 1 до 5
              <select
                value={value.wellbeing}
                onChange={(e) => change({ wellbeing: Number(e.target.value) })}
              >
                {[1, 2, 3, 4, 5].map((n) => (
                  <option key={n} value={n}>
                    {n}
                    {n === 1 ? ' — плохо' : n === 5 ? ' — отлично' : ''}
                  </option>
                ))}
              </select>
            </label>
          </div>
          <label>
            Сообщение тренеру
            <textarea
              maxLength={1000}
              rows={2}
              value={value.note}
              onChange={(e) => change({ note: e.target.value })}
            />
          </label>
          <button className="primary-button">
            {value.completed ? 'Обновить отметку' : 'Тренировка выполнена'}
          </button>
        </fieldset>
      </form>
      <p role="status">
        {busy ? 'Сохраняем…' : status || 'Отмечайте фактическое выполнение подходов.'}
      </p>
      {error && (
        <p role="alert" className="training-error">
          {error}{' '}
          {conflict ? (
            <button
              type="button"
              onClick={() => {
                if (
                  window.confirm(
                    'Убрать локальный черновик и загрузить актуальные отметки с сервера?',
                  )
                ) {
                  removeDraft(key);
                  onSaved();
                  onClose();
                }
              }}
            >
              Загрузить актуальные отметки
            </button>
          ) : (
            <button
              type="button"
              onClick={() => {
                setError('');
                void flush();
              }}
            >
              Отправить снова
            </button>
          )}
        </p>
      )}
    </section>
  );
};
