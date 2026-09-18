import React, { useEffect, useState } from 'react';
import type { TrainingStudent, TrainingStudentDetail, TrainingLesson } from '@kinetra/shared';
import { trainingApi, trainingMessage, inviteLink } from './api';
import { PlanEditor } from './PlanEditor';
export const TrainerWorkspace = ({ onChat }: { onChat: (id: string) => void }): React.ReactNode => {
  const [students, setStudents] = useState<TrainingStudent[] | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [detail, setDetail] = useState<TrainingStudentDetail | null>(null);
  const [lessons, setLessons] = useState<TrainingLesson[]>([]);
  const [revision, setRevision] = useState(0);
  const [query, setQuery] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [adding, setAdding] = useState(false);
  const [name, setName] = useState('');
  const [contact, setContact] = useState('');
  const [link, setLink] = useState('');
  const [copied, setCopied] = useState(false);
  const reload = () => setRevision((v) => v + 1);
  useEffect(() => {
    const c = new AbortController();
    void Promise.all([trainingApi.students(c.signal), trainingApi.library(c.signal)])
      .then(([s, l]) => {
        if (!c.signal.aborted) {
          setStudents(s.students);
          setLessons(l.lessons);
        }
      })
      .catch((e) => {
        if (!c.signal.aborted) setError(trainingMessage(e));
      });
    return () => c.abort();
  }, [revision]);
  useEffect(() => {
    if (!selected) return;
    const c = new AbortController();
    void trainingApi
      .student(selected, c.signal)
      .then((d) => {
        if (!c.signal.aborted) setDetail(d);
      })
      .catch((e) => {
        if (!c.signal.aborted) setError(trainingMessage(e));
      });
    return () => c.abort();
  }, [selected, revision]);
  const run = async (fn: () => Promise<void>) => {
    if (busy) return;
    setBusy(true);
    setError('');
    try {
      await fn();
    } catch (e) {
      setError(trainingMessage(e));
    } finally {
      setBusy(false);
    }
  };
  const active = students?.filter((s) => !s.archived_at) ?? [];
  const visible = active.filter((s) =>
    `${s.name} ${s.contact}`.toLowerCase().includes(query.toLowerCase()),
  );
  return (
    <main className="training-workspace" data-testid="trainer-workspace">
      <div className="training-heading">
        <div>
          <p className="survey-kicker">КАБИНЕТ ТРЕНЕРА</p>
          <h1>
            Мои ученики<span className="training-count">{active.length}</span>
          </h1>
          <p>Ваши программы. Ваши уроки. Прогресс каждого ученика.</p>
        </div>
        <button className="primary-button" type="button" onClick={() => setAdding((v) => !v)}>
          ＋ Добавить ученика
        </button>
      </div>
      {error && (
        <p className="training-error" role="alert">
          {error}{' '}
          <button
            type="button"
            onClick={() => {
              setError('');
              reload();
            }}
          >
            Повторить
          </button>
        </p>
      )}
      {adding && (
        <form
          className="training-card training-form"
          onSubmit={(e) => {
            e.preventDefault();
            void run(async () => {
              const added = await trainingApi.addStudent(name, contact);
              setLink(inviteLink(added.token));
              setCopied(false);
              setSelected(added.id);
              setDetail(null);
              setName('');
              setContact('');
              setAdding(false);
              reload();
            });
          }}
        >
          <h2>Новый ученик</h2>
          <div className="training-fields">
            <label>
              Имя
              <input
                autoFocus
                required
                maxLength={120}
                value={name}
                onChange={(e) => setName(e.target.value)}
                disabled={busy}
              />
            </label>
            <label>
              Контакт, необязательно
              <input
                maxLength={200}
                value={contact}
                placeholder="Телефон или почта"
                onChange={(e) => setContact(e.target.value)}
                disabled={busy}
              />
            </label>
          </div>
          <p className="training-muted">
            Вы получите ссылку для ученика. Программу можно составить сразу, результаты появятся
            после его подключения.
          </p>
          <button className="primary-button" disabled={busy}>
            Создать приглашение
          </button>
        </form>
      )}
      {link && (
        <section className="training-card training-invite">
          <h2>Приглашение готово</h2>
          <p>Отправьте ссылку ученику. Она действует 7 дней и принимается один раз.</p>
          <label>
            Ссылка для ученика
            <input readOnly value={link} onFocus={(e) => e.target.select()} />
          </label>
          <div className="training-actions">
            <button
              type="button"
              onClick={() => {
                void navigator.clipboard
                  .writeText(link)
                  .then(() => setCopied(true))
                  .catch(() => setError('Выделите и скопируйте ссылку из поля.'));
              }}
            >
              {copied ? 'Скопировано' : 'Скопировать ссылку'}
            </button>
            <button type="button" onClick={() => setLink('')}>
              Закрыть
            </button>
          </div>
        </section>
      )}
      {!students && !error && <p role="status">Загружаем учеников…</p>}
      {students && active.length === 0 && !adding && !selected && (
        <section className="training-empty">
          <h2>Начните с первого ученика</h2>
          <p>Добавьте его, составьте программу и прикрепите свои уроки.</p>
          <button type="button" className="primary-button" onClick={() => setAdding(true)}>
            Добавить ученика
          </button>
        </section>
      )}
      {(active.length > 0 || selected) && (
        <div className="training-columns">
          <aside className="training-roster">
            <label>
              Найти ученика
              <input
                type="search"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="Имя или контакт"
              />
            </label>
            {visible.map((s) => (
              <button
                type="button"
                className={`training-student ${s.id === selected ? 'is-selected' : ''}`}
                key={s.id}
                onClick={() => {
                  setSelected(s.id);
                  setDetail(null);
                  setError('');
                }}
                aria-pressed={s.id === selected}
              >
                <span className="training-avatar" aria-hidden="true">
                  {s.name.slice(0, 1).toUpperCase()}
                </span>
                <span>
                  <strong>{s.name}</strong>
                  <small>
                    {s.client_id ? `${s.completed} из ${s.total} занятий` : 'Ожидает подключения'}
                  </small>
                </span>
                <span aria-hidden="true">↗</span>
              </button>
            ))}
            {visible.length === 0 && <p>Ученики не найдены.</p>}
          </aside>
          <div className="training-detail">
            {!selected ? (
              <section className="training-empty">
                <h2>Выберите ученика</h2>
                <p>Здесь появятся его программа и результаты.</p>
              </section>
            ) : !detail ? (
              <p role="status">Загружаем программу…</p>
            ) : (
              <>
                <section className="training-card">
                  <div className="training-heading">
                    <div>
                      <p className="survey-kicker">УЧЕНИК</p>
                      <h2>{detail.student.name}</h2>
                      <p>{detail.student.contact}</p>
                    </div>
                    {detail.student.conversation_id && (
                      <button type="button" onClick={() => onChat(detail.student.conversation_id!)}>
                        Написать
                      </button>
                    )}
                  </div>
                  <div className="training-stats">
                    <div>
                      <strong>
                        {detail.student.completed} / {detail.student.total}
                      </strong>
                      <span>занятий в программе</span>
                    </div>
                    <div>
                      <strong>{detail.student.minutes}</strong>
                      <span>минут за всё время</span>
                    </div>
                    <div>
                      <strong>
                        {detail.student.last_completed_at
                          ? new Date(detail.student.last_completed_at).toLocaleDateString('ru-RU')
                          : '—'}
                      </strong>
                      <span>последняя тренировка</span>
                    </div>
                  </div>
                  <progress
                    max={Math.max(1, detail.student.total)}
                    value={detail.student.completed}
                    aria-label="Выполнение программы"
                  />
                  {!detail.student.client_id && (
                    <p>Ученик ещё не принял приглашение. Можно составить программу заранее.</p>
                  )}
                  {!detail.student.archived_at && (
                    <div className="training-actions">
                      <button
                        type="button"
                        className="primary-button"
                        disabled={busy}
                        onClick={() =>
                          void run(async () => {
                            await trainingApi.createPlan(selected);
                            reload();
                          })
                        }
                      >
                        Создать программу
                      </button>
                      {!detail.student.client_id && (
                        <button
                          type="button"
                          disabled={busy}
                          onClick={() =>
                            void run(async () => {
                              const result = await trainingApi.invite(selected);
                              setLink(inviteLink(result.token));
                              setCopied(false);
                            })
                          }
                        >
                          Новая ссылка приглашения
                        </button>
                      )}
                      <button
                        type="button"
                        disabled={busy}
                        onClick={() => {
                          if (
                            window.confirm(
                              'Убрать ученика из активного списка? Доступ к программе закроется, история сохранится.',
                            )
                          )
                            void run(async () => {
                              await trainingApi.archive(selected);
                              setSelected(null);
                              setDetail(null);
                              reload();
                            });
                        }}
                      >
                        В архив
                      </button>
                    </div>
                  )}
                </section>
                {detail.plans.length === 0 && (
                  <p className="training-empty">
                    Программы пока нет. Создайте её и добавьте занятия.
                  </p>
                )}
                {detail.plans.map((p) => (
                  <PlanEditor
                    key={`${p.id}:${p.revision}`}
                    plan={p}
                    lessons={lessons}
                    archivedStudent={!!detail.student.archived_at}
                    onSaved={reload}
                  />
                ))}
              </>
            )}
          </div>
        </div>
      )}
      {(students?.filter((s) => s.archived_at).length ?? 0) > 0 && (
        <details className="training-card">
          <summary>Архив учеников ({students?.filter((s) => s.archived_at).length})</summary>
          {students
            ?.filter((s) => s.archived_at)
            .map((s) => (
              <button
                type="button"
                key={s.id}
                onClick={() => {
                  setSelected(s.id);
                  setDetail(null);
                }}
              >
                {s.name} · {s.minutes} мин · открыть историю
              </button>
            ))}
        </details>
      )}
    </main>
  );
};
