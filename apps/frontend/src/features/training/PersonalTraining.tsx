import { MyCoachCard } from './CoachProfile';
import { AssignedLessons } from './AssignedLessons';
import { useEffect, useState } from 'react';
import type { MyTraining, TrainingWorkout } from '@kinetra/shared';
import { WorkoutSession } from './WorkoutSession';
import { ExerciseProgress, Measurements } from './Measurements';
import { ReminderSettings } from './ReminderSettings';
import { TrainingSupport } from './TrainingSupport';
import { trainingApi, trainingMessage } from './api';
import { draftKey, readDraft } from './drafts';
const trainingToday = (timezone: string, now = new Date()): string => {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(now);
  return ['year', 'month', 'day'].map((key) => parts.find((p) => p.type === key)!.value).join('-');
};
const displayDate = (date: string) =>
  new Date(date + 'T12:00:00').toLocaleDateString('ru-RU', { day: 'numeric', month: 'long' });
export const PersonalTraining = ({
  data,
  mode,
  accountId,
  timezone,
  onSaved,
  onChat,
}: {
  data: MyTraining;
  mode: 'home' | 'schedule' | 'progress';
  accountId: string;
  timezone: string;
  onSaved: () => void;
  onChat: () => void;
}) => {
  const current = data.plans.find((p) => p.status === 'published'),
    workouts = current?.workouts ?? [],
    all = data.plans.flatMap((p) => p.workouts),
    complete = all.filter((w) => w.completed_at),
    today = trainingToday(timezone);
  const [selected, setSelected] = useState<string | null>(null),
    [day, setDay] = useState(today),
    [month, setMonth] = useState(today.slice(0, 7)),
    [error, setError] = useState(''),
    [requests, setRequests] = useState<
      { id: string; workout_id: string; status: string; requested_date: string; reason: string }[]
    >([]),
    [reschedule, setReschedule] = useState<string | null>(null),
    [newDate, setNewDate] = useState(today),
    [reason, setReason] = useState(''),
    [busy, setBusy] = useState(false);
  useEffect(() => {
    let active = true;
    void trainingApi
      .reschedules()
      .then((v) => {
        if (active) setRequests(v.requests);
      })
      .catch((e) => {
        if (active) setError(trainingMessage(e));
      });
    return () => {
      active = false;
    };
  }, [data]);
  const session = workouts.find((w) => w.id === selected);
  const pending = workouts.filter(
    (w) => readDraft<{ pending: boolean }>(draftKey(accountId, 'workout', w.id))?.pending,
  );
  const card = (w: TrainingWorkout) => (
    <article
      key={w.id}
      className={`training-card training-client-workout ${w.completed_at ? 'is-complete' : ''}`}
    >
      <div className="training-actions">
        <span className="training-badge">
          {w.completed_at
            ? '✓ Выполнено'
            : w.scheduled_date
              ? displayDate(w.scheduled_date)
              : 'В удобный день'}
        </span>
        <span>
          {w.duration_minutes} мин · {w.exercises?.length ?? 0} упражнений
        </span>
      </div>
      <h3>{w.title}</h3>
      {w.instructions && <p className="training-instructions">{w.instructions}</p>}
      <div className="training-actions">
        <button
          type="button"
          className="primary-button"
          onClick={() => {
            setSelected(w.id);
            window.scrollTo({ top: 0, behavior: 'smooth' });
          }}
        >
          {w.completed_at ? 'Открыть результаты' : 'Начать тренировку'}
        </button>
        {!w.completed_at && (
          <button
            type="button"
            onClick={() => {
              setReschedule(w.id);
              setNewDate(w.scheduled_date ?? today);
              setReason('');
            }}
          >
            Попросить перенос
          </button>
        )}
      </div>
      {requests
        .filter((r) => r.workout_id === w.id)
        .slice(0, 1)
        .map((r) => (
          <p key={r.id} className="training-muted">
            {r.status === 'pending'
              ? `Тренер рассматривает перенос на ${displayDate(r.requested_date)}`
              : r.status === 'approved'
                ? `Перенос на ${displayDate(r.requested_date)} одобрен`
                : 'Тренер отклонил перенос. Напишите ему, чтобы выбрать другой день.'}
          </p>
        ))}
    </article>
  );
  const scheduledToday = workouts.filter((w) => w.scheduled_date === today),
    undated = workouts.filter((w) => !w.scheduled_date && !w.completed_at),
    next = workouts
      .filter((w) => w.scheduled_date && w.scheduled_date > today && !w.completed_at)
      .sort((a, b) => a.scheduled_date!.localeCompare(b.scheduled_date!))[0];
  const dates = (() => {
    const [y, m] = month.split('-').map(Number);
    const count = new Date(Date.UTC(y!, m!, 0)).getUTCDate();
    const offset = (new Date(Date.UTC(y!, m! - 1, 1)).getUTCDay() + 6) % 7;
    return {
      offset,
      days: Array.from({ length: count }, (_, i) => `${month}-${String(i + 1).padStart(2, '0')}`),
    };
  })();
  const moveMonth = (delta: number) => {
    const d = new Date(`${month}-15T12:00:00Z`);
    d.setUTCMonth(d.getUTCMonth() + delta);
    setMonth(d.toISOString().slice(0, 7));
  };
  return (
    <main className="training-workspace training-personal" data-testid={`personal-${mode}`}>
      <div className="training-heading">
        <div>
          <p className="survey-kicker">ВАШ ТРЕНЕР · {data.trainer_name}</p>
          <h1>
            {mode === 'home' ? 'Сегодня' : mode === 'schedule' ? 'Расписание' : 'Мой прогресс'}
          </h1>
        </div>
        <button type="button" onClick={onChat}>
          Написать тренеру
        </button>
      </div>
      {session ? (
        <WorkoutSession
          key={session.id}
          workout={session}
          accountId={accountId}
          onClose={() => {
            setSelected(null);
            onSaved();
          }}
          onSaved={onSaved}
          onChat={onChat}
        />
      ) : (
        <>
          {pending.length > 0 && (
            <section className="training-card training-pending">
              <h2>Есть неотправленные отметки</h2>
              <p>Откройте тренировку, чтобы отправить сохранённые на устройстве результаты.</p>
              {pending.map((w) => (
                <button type="button" key={w.id} onClick={() => setSelected(w.id)}>
                  {w.title} →
                </button>
              ))}
            </section>
          )}
          {!current && !data.assigned_lessons?.length && (
            <section className="training-empty">
              <h2>Тренер готовит вашу программу</h2>
              <p>Назначенные занятия появятся здесь.</p>
            </section>
          )}
          {mode === 'progress' && (
            <MyCoachCard
              key={
                complete.length + (data.assigned_lessons?.filter((l) => l.completed_at).length ?? 0)
              }
            />
          )}
          {mode === 'home' && (
            <>
              {current?.goal && <p className="training-goal">{current.goal}</p>}
              {scheduledToday.length ? (
                scheduledToday.map(card)
              ) : current ? (
                <section className="training-card training-rest-day">
                  <p className="survey-kicker">ВАШ РИТМ</p>
                  <h2>Сегодня день без назначенных занятий</h2>
                  <p>
                    {next
                      ? `Следующая тренировка — ${displayDate(next.scheduled_date!)}.`
                      : undated.length
                        ? 'Есть занятия, которые можно пройти в удобный день.'
                        : 'Следующие занятия назначит ваш тренер.'}
                  </p>
                  <button type="button" onClick={onChat}>
                    Связаться с тренером
                  </button>
                </section>
              ) : null}
              {!scheduledToday.length && next && (
                <section>
                  <h2>Следующее занятие</h2>
                  {card(next)}
                </section>
              )}
              {undated.length > 0 && (
                <section>
                  <h2>В удобный день</h2>
                  {undated.slice(0, 1).map(card)}
                </section>
              )}
              <AssignedLessons lessons={data.assigned_lessons ?? []} onSaved={onSaved} />
              <ReminderSettings timezone={timezone} />
            </>
          )}
          {mode === 'schedule' && (
            <>
              <section className="training-card">
                <div className="training-heading">
                  <button type="button" onClick={() => moveMonth(-1)} aria-label="Предыдущий месяц">
                    ←
                  </button>
                  <h2>
                    {new Date(`${month}-15T12:00:00`).toLocaleDateString('ru-RU', {
                      month: 'long',
                      year: 'numeric',
                    })}
                  </h2>
                  <button type="button" onClick={() => moveMonth(1)} aria-label="Следующий месяц">
                    →
                  </button>
                </div>
                <div className="training-calendar">
                  {['Пн', 'Вт', 'Ср', 'Чт', 'Пт', 'Сб', 'Вс'].map((d) => (
                    <span className="training-calendar-weekday" key={d}>
                      {d}
                    </span>
                  ))}
                  {Array.from({ length: dates.offset }, (_, i) => (
                    <span key={`space${i}`} aria-hidden="true" />
                  ))}
                  {dates.days.map((d) => {
                    const entries = workouts.filter((w) => w.scheduled_date === d);
                    return (
                      <button
                        type="button"
                        key={d}
                        className={`${d === day ? 'is-selected ' : ''}${d === today ? 'is-today' : ''}`}
                        aria-pressed={d === day}
                        aria-label={`${displayDate(d)}, ${entries.length ? `${entries.length} занятий` : 'день отдыха'}`}
                        onClick={() => setDay(d)}
                      >
                        <span>{Number(d.slice(-2))}</span>
                        <small>
                          {entries.length ? (entries.every((w) => w.completed_at) ? '✓' : '●') : ''}
                        </small>
                      </button>
                    );
                  })}
                </div>
              </section>
              <section>
                <h2>{displayDate(day)}</h2>
                {workouts.filter((w) => w.scheduled_date === day).length ? (
                  workouts.filter((w) => w.scheduled_date === day).map(card)
                ) : (
                  <p className="training-muted">На этот день занятия не назначены.</p>
                )}
              </section>
              {undated.length > 0 && (
                <section>
                  <h2>Без привязки к дате</h2>
                  {undated.map(card)}
                </section>
              )}
              <AssignedLessons lessons={data.assigned_lessons ?? []} onSaved={onSaved} />
              <ReminderSettings timezone={timezone} />
            </>
          )}
          {mode === 'progress' && (
            <>
              <section className="training-card">
                <h2>{current?.title ?? 'История занятий'}</h2>
                <div className="training-stats">
                  <div>
                    <strong>
                      {workouts.filter((w) => w.completed_at).length} / {workouts.length}
                    </strong>
                    <span>занятий в программе</span>
                  </div>
                  <div>
                    <strong>{complete.length}</strong>
                    <span>выполнено за всё время</span>
                  </div>
                  <div>
                    <strong>{complete.reduce((n, w) => n + w.duration_minutes, 0)}</strong>
                    <span>минут по плану</span>
                  </div>
                </div>
                <progress
                  aria-label="Выполнение программы"
                  max={Math.max(1, workouts.length)}
                  value={workouts.filter((w) => w.completed_at).length}
                />
              </section>
              <AssignedLessons lessons={data.assigned_lessons ?? []} onSaved={onSaved} />
              <ExerciseProgress plans={data.plans} />
              <Measurements />
              {data.plans.map((p) => (
                <details className="training-card" key={p.id}>
                  <summary>
                    {p.status === 'archived' ? 'История: ' : ''}
                    {p.title}
                  </summary>
                  {p.workouts
                    .filter((w) => w.completed_at)
                    .map((w) => (
                      <article className="training-measurement" key={w.id}>
                        <strong>{w.title}</strong>
                        <p>
                          {new Date(w.completed_at!).toLocaleDateString('ru-RU')} · сложность{' '}
                          {w.difficulty ?? '—'}/5 · самочувствие {w.wellbeing ?? '—'}/5
                        </p>
                        {w.note && <p>{w.note}</p>}
                        {p.status === 'published' && (
                          <button type="button" onClick={() => setSelected(w.id)}>
                            Посмотреть подходы
                          </button>
                        )}
                      </article>
                    ))}
                </details>
              ))}
              <details className="training-card">
                <summary>Проблема в работе с тренером</summary>
                <TrainingSupport />
              </details>
            </>
          )}
        </>
      )}
      {reschedule && (
        <section className="training-card">
          <form
            className="training-form"
            onSubmit={(e) => {
              e.preventDefault();
              setBusy(true);
              setError('');
              void trainingApi
                .reschedule(reschedule, newDate, reason)
                .then(() => {
                  setReschedule(null);
                  onSaved();
                })
                .catch((e) => setError(trainingMessage(e)))
                .finally(() => setBusy(false));
            }}
          >
            <h2>Попросить перенос занятия</h2>
            <label>
              Удобная дата
              <input
                type="date"
                required
                value={newDate}
                onChange={(e) => setNewDate(e.target.value)}
              />
            </label>
            <label>
              Комментарий тренеру
              <textarea
                maxLength={1000}
                value={reason}
                onChange={(e) => setReason(e.target.value)}
              />
            </label>
            <div className="training-actions">
              <button className="primary-button" disabled={busy}>
                Отправить тренеру
              </button>
              <button type="button" disabled={busy} onClick={() => setReschedule(null)}>
                Отмена
              </button>
            </div>
          </form>
        </section>
      )}
      {error && (
        <p role="alert" className="training-error">
          {error}
        </p>
      )}
    </main>
  );
};
