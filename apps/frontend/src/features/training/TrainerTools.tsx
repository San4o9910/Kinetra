import { useEffect, useState } from 'react';
import type { TrainingAttention, TrainingTemplate } from '@kinetra/shared';
import { trainingApi, trainingMessage } from './api';
export const TrainerAttention = ({
  revision,
  onSelect,
  onChanged,
}: {
  revision: number;
  onSelect: (id: string) => void;
  onChanged: () => void;
}) => {
  const [events, setEvents] = useState<TrainingAttention[]>([]),
    [error, setError] = useState(''),
    [busy, setBusy] = useState(false);
  useEffect(() => {
    let active = true;
    void trainingApi
      .attention()
      .then((v) => {
        if (active) setEvents(v.events);
      })
      .catch((e) => {
        if (active) setError(trainingMessage(e));
      });
    return () => {
      active = false;
    };
  }, [revision]);
  const review = (id: string, approve: boolean) => {
    setBusy(true);
    setError('');
    void trainingApi
      .reviewReschedule(id, approve)
      .then(onChanged)
      .catch((e) => setError(trainingMessage(e)))
      .finally(() => setBusy(false));
  };
  return (
    <section className="training-attention" aria-label="Требует внимания">
      <div className="training-heading">
        <h2>На сегодня</h2>
        <span className="training-badge">
          {events.length}{' '}
          {new Intl.PluralRules('ru').select(events.length) === 'one'
            ? 'событие'
            : new Intl.PluralRules('ru').select(events.length) === 'few'
              ? 'события'
              : 'событий'}
        </span>
      </div>
      {events.length ? (
        <div className="training-attention-list">
          {events.map((e, i) => (
            <article
              key={`${e.student_id}:${e.kind}:${i}`}
              className={`training-attention-item is-${e.kind}`}
            >
              <button
                type="button"
                onClick={() => {
                  onSelect(e.student_id);
                  if (e.kind === 'report')
                    void trainingApi
                      .seen(e.student_id)
                      .then(onChanged)
                      .catch((err) => setError(trainingMessage(err)));
                }}
              >
                <strong>{e.name}</strong>
                <span>{e.title}</span>
              </button>
              {e.kind === 'reschedule' && e.request_id && (
                <>
                  <p>
                    Новая дата: {e.requested_date}
                    {e.reason ? ` · ${e.reason}` : ''}
                  </p>
                  <div className="training-actions">
                    <button
                      type="button"
                      disabled={busy}
                      onClick={() => review(e.request_id!, true)}
                    >
                      Одобрить перенос
                    </button>
                    <button
                      type="button"
                      disabled={busy}
                      onClick={() => review(e.request_id!, false)}
                    >
                      Отклонить
                    </button>
                  </div>
                </>
              )}
            </article>
          ))}
        </div>
      ) : (
        <p className="training-muted">
          Новых событий нет. Отчёты учеников и запросы переноса появятся здесь.
        </p>
      )}
      {error && <p role="alert">{error}</p>}
    </section>
  );
};
export const TemplatePicker = ({
  studentId,
  onAssigned,
}: {
  studentId: string;
  onAssigned: () => void;
}) => {
  const [open, setOpen] = useState(false),
    [templates, setTemplates] = useState<TrainingTemplate[]>([]),
    [choice, setChoice] = useState(''),
    [start, setStart] = useState(''),
    [busy, setBusy] = useState(false),
    [error, setError] = useState('');
  const load = () => {
    setError('');
    void trainingApi
      .templates()
      .then((v) => setTemplates(v.templates))
      .catch((e) => setError(trainingMessage(e)));
  };
  return (
    <section className="training-template-picker">
      <button
        type="button"
        onClick={() => {
          setOpen((v) => !v);
          load();
        }}
      >
        Выбрать из моих шаблонов
      </button>
      {open && (
        <form
          className="training-form training-card"
          onSubmit={(e) => {
            e.preventDefault();
            setBusy(true);
            setError('');
            void trainingApi
              .assignTemplate(studentId, choice, start || null)
              .then(() => {
                setOpen(false);
                onAssigned();
              })
              .catch((e) => setError(trainingMessage(e)))
              .finally(() => setBusy(false));
          }}
        >
          <h3>Программа из шаблона</h3>
          {templates.length ? (
            <>
              <label>
                Шаблон
                <select required value={choice} onChange={(e) => setChoice(e.target.value)}>
                  <option value="">Выберите программу</option>
                  {templates.map((t) => (
                    <option key={t.id} value={t.id}>
                      {t.title} · {t.workouts.length} занятий
                    </option>
                  ))}
                </select>
              </label>
              <label>
                Дата начала · необязательно
                <input type="date" value={start} onChange={(e) => setStart(e.target.value)} />
              </label>
              <p className="training-muted">
                Создастся отдельный черновик. Вы сможете изменить нагрузку и назначить его этому
                ученику.
              </p>
              <div className="training-actions">
                <button className="primary-button" disabled={busy || !choice}>
                  Создать программу
                </button>
                <button
                  type="button"
                  disabled={busy || !choice}
                  onClick={() => {
                    if (window.confirm('Удалить шаблон? Программы учеников сохранятся.')) {
                      setBusy(true);
                      void trainingApi
                        .removeTemplate(choice)
                        .then(() => {
                          setChoice('');
                          load();
                        })
                        .catch((e) => setError(trainingMessage(e)))
                        .finally(() => setBusy(false));
                    }
                  }}
                >
                  Удалить шаблон
                </button>
              </div>
            </>
          ) : (
            <p>Откройте составленную программу и нажмите «Сохранить как шаблон».</p>
          )}
          {error && <p role="alert">{error}</p>}
        </form>
      )}
    </section>
  );
};
