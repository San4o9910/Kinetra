import { useEffect, useState } from 'react';
import type { TrainingComplaint } from '@kinetra/shared';
import { trainingApi, trainingMessage } from './api';
export const TrainingSupport = ({ admin = false }: { admin?: boolean }) => {
  const [items, setItems] = useState<TrainingComplaint[]>([]),
    [reason, setReason] = useState(''),
    [revision, setRevision] = useState(0),
    [error, setError] = useState(''),
    [busy, setBusy] = useState(false),
    [reply, setReply] = useState<Record<string, string>>({}),
    [filter, setFilter] = useState('all');
  useEffect(() => {
    let active = true;
    void trainingApi
      .complaints(admin)
      .then((v) => {
        if (active) setItems(v.complaints);
      })
      .catch((e) => {
        if (active) setError(trainingMessage(e));
      });
    return () => {
      active = false;
    };
  }, [admin, revision]);
  const run = async (fn: () => Promise<unknown>) => {
    setBusy(true);
    setError('');
    try {
      await fn();
      setRevision((v) => v + 1);
      setReason('');
    } catch (e) {
      setError(trainingMessage(e));
    } finally {
      setBusy(false);
    }
  };
  const labels: Record<string, string> = {
    new: 'Новое обращение',
    reviewing: 'На рассмотрении',
    resolved: 'Рассмотрено',
  };
  return (
    <section className="training-card training-form">
      <h2>{admin ? 'Обращения учеников' : 'Связаться с администрацией'}</h2>
      {admin ? (
        <label>
          Показать
          <select value={filter} onChange={(e) => setFilter(e.target.value)}>
            <option value="all">Все обращения</option>
            {Object.entries(labels).map(([v, l]) => (
              <option key={v} value={v}>
                {l}
              </option>
            ))}
          </select>
        </label>
      ) : (
        <form
          className="training-form"
          onSubmit={(e) => {
            e.preventDefault();
            void run(() => trainingApi.complain(reason));
          }}
        >
          <label>
            Что произошло?
            <textarea
              required
              minLength={10}
              maxLength={2000}
              rows={3}
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              placeholder="Опишите проблему в работе с тренером"
            />
          </label>
          <p className="training-muted">
            Обращение получит администратор Kinetra. Оно не публикуется в общем доступе.
          </p>
          <button className="secondary-button" disabled={busy || reason.trim().length < 10}>
            Отправить обращение
          </button>
        </form>
      )}
      {items
        .filter((i) => filter === 'all' || filter === i.status)
        .map((c) => (
          <article className="training-measurement" key={c.id}>
            <span className="training-badge">{labels[c.status]}</span>
            <h3>{admin ? `${c.client_name} → ${c.trainer_name}` : c.trainer_name}</h3>
            <p>{c.reason}</p>
            <details>
              <summary>История рассмотрения</summary>
              <ol>
                {c.events.map((e, i) => (
                  <li key={i}>
                    <strong>{labels[e.status]}</strong> ·{' '}
                    {new Date(e.created_at).toLocaleString('ru-RU')}
                    <p>{e.reason}</p>
                  </li>
                ))}
              </ol>
            </details>
            {admin && c.status !== 'resolved' && (
              <form
                className="training-form"
                onSubmit={(e) => {
                  e.preventDefault();
                  void run(() =>
                    trainingApi.reviewComplaint(c.id, 'resolved', reply[c.id] ?? '', c.revision),
                  );
                }}
              >
                <label>
                  Ответ администратора
                  <textarea
                    required
                    maxLength={2000}
                    value={reply[c.id] ?? ''}
                    onChange={(e) => setReply((v) => ({ ...v, [c.id]: e.target.value }))}
                  />
                </label>
                <div className="training-actions">
                  {c.status === 'new' && (
                    <button
                      type="button"
                      disabled={busy}
                      onClick={() =>
                        void run(() =>
                          trainingApi.reviewComplaint(
                            c.id,
                            'reviewing',
                            reply[c.id]?.trim() || 'Обращение принято в работу.',
                            c.revision,
                          ),
                        )
                      }
                    >
                      Взять в работу
                    </button>
                  )}
                  <button type="submit" disabled={busy || !reply[c.id]?.trim()}>
                    Сохранить решение
                  </button>
                </div>
              </form>
            )}
          </article>
        ))}
      {items.length === 0 && <p className="training-muted">Обращений пока нет.</p>}
      {error && (
        <p role="alert" className="training-error">
          {error}
        </p>
      )}
    </section>
  );
};
export const VerificationHistory = ({ id }: { id: string }) => {
  const [events, setEvents] = useState<
      { from_status: string | null; to_status: string; reason: string | null; created_at: string }[]
    >([]),
    [error, setError] = useState('');
  useEffect(() => {
    let active = true;
    void trainingApi
      .verificationHistory(id)
      .then((v) => {
        if (active) setEvents(v.events);
      })
      .catch((e) => {
        if (active) setError(trainingMessage(e));
      });
    return () => {
      active = false;
    };
  }, [id]);
  const labels: Record<string, string> = {
    pending: 'На проверке',
    needs_more_info: 'Запрошены уточнения',
    approved: 'Одобрена',
    rejected: 'Отклонена',
    withdrawn: 'Отозвана',
  };
  const replied = events.some(
    (e) => e.from_status === 'needs_more_info' && e.to_status === 'pending',
  );
  return (
    <section>
      <h3>История заявки</h3>
      {replied && <p className="training-badge">Кандидат прислал дополнения</p>}
      <ol className="training-audit">
        {events.map((e, i) => (
          <li key={`${e.created_at}:${i}`}>
            <strong>
              {e.from_status === 'needs_more_info' && e.to_status === 'pending'
                ? 'Получены дополнения кандидата'
                : (labels[e.to_status] ?? e.to_status)}
            </strong>
            <small>{new Date(e.created_at).toLocaleString('ru-RU')}</small>
            {e.reason && <p>{e.reason}</p>}
          </li>
        ))}
      </ol>
      {error && <p role="alert">{error}</p>}
    </section>
  );
};
