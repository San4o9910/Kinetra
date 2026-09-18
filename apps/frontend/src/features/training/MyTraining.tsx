import React, { useEffect, useState } from 'react';
import type { MyTraining as MyTrainingData, TrainingWorkout } from '@kinetra/shared';
import { trainingApi, trainingMessage, pendingInvite, clearInvite } from './api';
import { TrainingPlayer } from './TrainingPlayer';

const StudentWorkout = ({
  workout,
  archived,
  onSaved,
}: {
  workout: TrainingWorkout;
  archived: boolean;
  onSaved: () => void;
}): React.ReactNode => {
  const [open, setOpen] = useState(false);
  const [difficulty, setDifficulty] = useState(workout.difficulty ?? 3);
  const [wellbeing, setWellbeing] = useState(workout.wellbeing ?? 3);
  const [note, setNote] = useState(workout.note);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  return (
    <article
      className={`training-card training-client-workout ${workout.completed_at ? 'is-complete' : ''}`}
    >
      <div className="training-actions">
        <span className="training-badge">
          {workout.completed_at
            ? '✓ Выполнено'
            : workout.scheduled_date
              ? new Date(`${workout.scheduled_date}T12:00:00`).toLocaleDateString('ru-RU', {
                  day: 'numeric',
                  month: 'long',
                })
              : 'В удобный день'}
        </span>
        <span>{workout.duration_minutes} мин</span>
      </div>
      <h3>{workout.title}</h3>
      {workout.instructions && <p className="training-instructions">{workout.instructions}</p>}
      {workout.lesson_id && (
        <>
          <button type="button" onClick={() => setOpen((v) => !v)}>
            {open ? 'Свернуть урок' : '▶ Открыть видеоурок'}
          </button>
          {open && (
            <TrainingPlayer
              key={workout.lesson_id}
              id={workout.lesson_id}
              title={workout.lesson_title ?? workout.title}
              position={workout.position_seconds}
              {...(archived
                ? {}
                : {
                    onPosition: (seconds: number) => {
                      void trainingApi
                        .log(workout.id, { position_seconds: seconds })
                        .catch((e) => setError(trainingMessage(e)));
                    },
                  })}
            />
          )}
        </>
      )}
      {!archived ? (
        <form
          className="training-form training-completion"
          onSubmit={(e) => {
            e.preventDefault();
            if (busy) return;
            setBusy(true);
            setError('');
            void trainingApi
              .log(workout.id, { completed: true, difficulty, wellbeing, note })
              .then(onSaved)
              .catch((e) => setError(trainingMessage(e)))
              .finally(() => setBusy(false));
          }}
        >
          <details open={!!workout.completed_at}>
            <summary>
              {workout.completed_at ? 'Ваши отметки' : 'Завершить занятие и оставить отметку'}
            </summary>
            <div className="training-fields">
              <label>
                Сложность, от 1 до 5
                <select value={difficulty} onChange={(e) => setDifficulty(Number(e.target.value))}>
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
                <select value={wellbeing} onChange={(e) => setWellbeing(Number(e.target.value))}>
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
                value={note}
                onChange={(e) => setNote(e.target.value)}
                placeholder="Как прошло занятие?"
              />
            </label>
            <button className="primary-button" disabled={busy}>
              {busy
                ? 'Сохраняем…'
                : workout.completed_at
                  ? 'Обновить отметку'
                  : 'Тренировка выполнена'}
            </button>
          </details>
        </form>
      ) : (
        workout.completed_at && (
          <p>
            Выполнено {new Date(workout.completed_at).toLocaleDateString('ru-RU')} · {workout.note}
          </p>
        )
      )}
      {error && (
        <p role="alert" className="training-error">
          {error}
        </p>
      )}
    </article>
  );
};
export const MyTraining = ({
  mode = 'home',
  fallback,
  onOpenChat,
}: {
  mode?: 'home' | 'schedule' | 'progress';
  fallback?: React.ReactNode;
  onOpenChat: () => void;
}): React.ReactNode => {
  const [data, setData] = useState<MyTrainingData | null>(null);
  const [revision, setRevision] = useState(0);
  const [error, setError] = useState('');
  const [token, setToken] = useState(pendingInvite);
  const [trainer, setTrainer] = useState('');
  const [busy, setBusy] = useState(false);
  const [inviteError, setInviteError] = useState('');
  useEffect(() => {
    const c = new AbortController();
    void trainingApi
      .mine(c.signal)
      .then((v) => {
        if (!c.signal.aborted) {
          setData(v);
          setError('');
        }
      })
      .catch((e) => {
        if (!c.signal.aborted) setError(trainingMessage(e));
      });
    return () => c.abort();
  }, [revision]);
  useEffect(() => {
    if (token.length !== 43) {
      setTrainer('');
      return;
    }
    let active = true;
    void trainingApi
      .invitation(token)
      .then((v) => {
        if (active) {
          setTrainer(v.trainer_name);
          setInviteError('');
        }
      })
      .catch((e) => {
        if (active) {
          setTrainer('');
          setInviteError(trainingMessage(e));
        }
      });
    return () => {
      active = false;
    };
  }, [token]);
  const invitation = (
    <section className="training-card training-invite">
      <h2>{trainer ? `Приглашение от тренера ${trainer}` : 'Подключитесь к своему тренеру'}</h2>
      <p>
        Тренер добавляет вас в свой кабинет и отправляет ссылку. После подключения здесь появится
        составленная им программа.
      </p>
      <label>
        Ссылка или код приглашения
        <input
          value={token}
          onChange={(e) => {
            let value = e.target.value.trim();
            try {
              const url = new URL(value);
              value = new URLSearchParams(url.hash.slice(1)).get('invite') ?? value;
            } catch {
              /* A bare token is also supported. */
            }
            setToken(value);
          }}
          placeholder="Вставьте ссылку от тренера"
        />
      </label>
      {trainer && (
        <>
          <p>Тренер увидит выполнение ваших занятий и отметки самочувствия.</p>
          <button
            type="button"
            className="primary-button"
            disabled={busy}
            onClick={() => {
              setBusy(true);
              setInviteError('');
              void trainingApi
                .accept(token)
                .then(() => {
                  clearInvite();
                  setToken('');
                  setTrainer('');
                  setRevision((v) => v + 1);
                })
                .catch((e) => setInviteError(trainingMessage(e)))
                .finally(() => setBusy(false));
            }}
          >
            {busy ? 'Подключаем…' : 'Подключиться к тренеру'}
          </button>
        </>
      )}
      {inviteError && <p role="alert">{inviteError}</p>}
      {token && (
        <button
          type="button"
          onClick={() => {
            clearInvite();
            setToken('');
            setInviteError('');
          }}
        >
          Закрыть приглашение
        </button>
      )}
    </section>
  );
  if (error)
    return (
      <section className="training-card">
        <p role="alert">{error}</p>
        <button
          type="button"
          onClick={() => {
            setError('');
            setRevision((v) => v + 1);
          }}
        >
          Повторить
        </button>
      </section>
    );
  if (!data)
    return (
      <p className="training-empty" role="status">
        Загружаем вашу программу…
      </p>
    );
  if (!data.student_id)
    return (
      <>
        {invitation}
        {fallback && (
          <>
            <p className="training-course-label">
              Вводный курс Kinetra · программа тренера появится после подключения
            </p>
            {fallback}
          </>
        )}
      </>
    );
  const current = data.plans.find((p) => p.status === 'published');
  const all = data.plans.flatMap((p) => p.workouts);
  const completed = all.filter((w) => w.completed_at);
  const currentDone = current?.workouts.filter((w) => w.completed_at).length ?? 0;
  return (
    <main className="training-workspace training-personal">
      <div className="training-heading">
        <div>
          <p className="survey-kicker">ВАШ ТРЕНЕР · {data.trainer_name}</p>
          <h1>
            {mode === 'progress'
              ? 'Мой прогресс'
              : mode === 'schedule'
                ? 'Мои занятия'
                : (current?.title ?? 'Моя программа')}
          </h1>
        </div>
        <button type="button" onClick={onOpenChat}>
          Написать тренеру
        </button>
      </div>
      {token && invitation}
      <section className="training-card">
        <div className="training-stats">
          <div>
            <strong>
              {currentDone} / {current?.workouts.length ?? 0}
            </strong>
            <span>занятий в программе</span>
          </div>
          <div>
            <strong>{completed.length}</strong>
            <span>выполнено за всё время</span>
          </div>
          <div>
            <strong>{completed.reduce((sum, w) => sum + w.duration_minutes, 0)}</strong>
            <span>минут тренировок</span>
          </div>
        </div>
        <progress
          max={Math.max(1, current?.workouts.length ?? 0)}
          value={currentDone}
          aria-label="Ваш прогресс"
        />
        {current?.goal && <p className="training-instructions">{current.goal}</p>}
      </section>
      {!current && (
        <section className="training-empty">
          <h2>Тренер готовит вашу программу</h2>
          <p>Как только он назначит занятия, они появятся здесь.</p>
        </section>
      )}
      {(mode === 'progress'
        ? current?.workouts.filter((w) => w.completed_at)
        : current?.workouts
      )?.map((w) => (
        <StudentWorkout
          key={w.id}
          workout={w}
          archived={false}
          onSaved={() => setRevision((v) => v + 1)}
        />
      ))}
      {mode === 'progress' && currentDone === 0 && (
        <p className="training-empty">Здесь появятся ваши выполненные занятия и отметки.</p>
      )}
      {data.plans
        .filter((p) => p.status === 'archived')
        .map((p) => (
          <details className="training-card" key={p.id}>
            <summary>История: {p.title}</summary>
            {p.workouts.map((w) => (
              <StudentWorkout key={w.id} workout={w} archived onSaved={() => undefined} />
            ))}
          </details>
        ))}
    </main>
  );
};
