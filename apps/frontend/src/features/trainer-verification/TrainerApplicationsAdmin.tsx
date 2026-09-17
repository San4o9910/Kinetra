import React from 'react';
import { useCallback, useEffect, useRef, useState } from 'react';
import type { TrainerVerificationRequestDto, TrainerVerificationStatus } from '@kinetra/shared';
import { ApiRequestError, listTrainerApplications, reviewTrainerApplication } from '../../lib/api';
import { KineticMark } from '../navigation/KineticMark';

const labels: Record<TrainerVerificationStatus | 'not_started', string> = {
  pending: 'Новые',
  needs_more_info: 'Ждём дополнений',
  approved: 'Одобрены',
  rejected: 'Отклонены',
  withdrawn: 'Отозваны',
  not_started: 'Черновик',
};
type Action = 'approve' | 'request-info' | 'reject';
const actionLabels: Record<Action, string> = {
  approve: 'Одобрить заявку',
  'request-info': 'Запросить дополнения',
  reject: 'Отклонить заявку',
};

export const TrainerApplicationsAdmin = ({
  accountId,
  onBack,
  onSessionExpired,
}: {
  readonly accountId: string;
  readonly onBack: () => void;
  readonly onSessionExpired: () => void;
}): React.ReactNode => {
  const [status, setStatus] = useState<TrainerVerificationStatus>('pending');
  const [requests, setRequests] = useState<readonly TrainerVerificationRequestDto[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [action, setAction] = useState<Action | null>(null);
  const [reason, setReason] = useState('');
  const [saving, setSaving] = useState(false);
  const gate = useRef(false);
  const detailRef = useRef<HTMLElement>(null);
  useEffect(() => {
    if (selectedId !== null && window.matchMedia('(max-width: 720px)').matches) {
      detailRef.current?.focus({ preventScroll: true });
      detailRef.current?.scrollIntoView({ block: 'start' });
    }
  }, [selectedId]);
  const controller = useRef<AbortController | null>(null);
  const mounted = useRef(true);
  const explain = useCallback(
    (caught: unknown): string => {
      if (caught instanceof ApiRequestError) {
        if (caught.kind === 'auth') onSessionExpired();
        if (caught.code === 'SELF_REVIEW_FORBIDDEN') return 'Свою заявку одобрять нельзя.';
        if (caught.code.includes('EMAIL'))
          return 'Кандидату нужно подтвердить email перед одобрением.';
        if (caught.status === 403) return 'Для этого раздела нужны права администратора заявок.';
        if (caught.status === 409)
          return 'Статус заявки изменился. Обновите список перед решением.';
      }
      return 'Не удалось выполнить действие. Проверьте подключение и повторите.';
    },
    [onSessionExpired],
  );
  const load = useCallback(async (): Promise<void> => {
    controller.current?.abort();
    const current = new AbortController();
    controller.current = current;
    setLoading(true);
    setError(null);
    try {
      const data = await listTrainerApplications(status, current.signal);
      if (current.signal.aborted) return;
      setRequests(data.requests);
      setSelectedId((id) => (data.requests.some((item) => item.id === id) ? id : null));
    } catch (caught) {
      if (!current.signal.aborted) {
        setError(explain(caught));
        setRequests([]);
        setSelectedId(null);
      }
    } finally {
      if (!current.signal.aborted) setLoading(false);
    }
  }, [status, explain]);
  useEffect(() => {
    mounted.current = true;
    void load();
    return () => {
      mounted.current = false;
      controller.current?.abort();
    };
  }, [load]);
  const selected = requests.find((item) => item.id === selectedId);
  const visible = requests.filter((item) =>
    `${item.display_name} ${item.specialization} ${item.city}`
      .toLocaleLowerCase('ru-RU')
      .includes(query.toLocaleLowerCase('ru-RU')),
  );
  const actionable =
    selected !== undefined &&
    selected.user_id !== accountId &&
    (selected.status === 'pending' || selected.status === 'needs_more_info');
  const confirm = async (): Promise<void> => {
    if (
      gate.current ||
      !actionable ||
      action === null ||
      (action !== 'approve' && reason.trim() === '')
    )
      return;
    gate.current = true;
    setSaving(true);
    setError(null);
    try {
      await reviewTrainerApplication(selected.id, action, reason.trim() || undefined);
      if (!mounted.current) return;
      setNotice(
        action === 'approve'
          ? 'Заявка одобрена. Кандидат получил доступ к кабинету тренера.'
          : 'Решение сохранено. Кандидат увидит ваш комментарий.',
      );
      setAction(null);
      setReason('');
      await load();
    } catch (caught) {
      if (mounted.current) setError(explain(caught));
    } finally {
      gate.current = false;
      if (mounted.current) setSaving(false);
    }
  };
  return (
    <main className="review-shell" data-testid="trainer-applications-admin">
      <header className="review-heading">
        <div className="review-brand">
          <KineticMark />
          <span>KINETRA / АДМИНИСТРАТОР</span>
        </div>
        <button className="secondary-button" type="button" onClick={onBack} disabled={saving}>
          В приложение
        </button>
      </header>
      <div className="review-title">
        <p className="program-kicker">КОМАНДА KINETRA</p>
        <h1>Заявки тренеров</h1>
        <p>Квалификация, материалы и решение — в одном месте.</p>
      </div>
      <div className="review-toolbar">
        <label>
          Статус
          <select
            value={status}
            disabled={saving}
            onChange={(event) => {
              setStatus(event.target.value as TrainerVerificationStatus);
              setSelectedId(null);
              setAction(null);
              setNotice(null);
            }}
          >
            {Object.entries(labels)
              .filter(([key]) => key !== 'not_started')
              .map(([key, label]) => (
                <option key={key} value={key}>
                  {label}
                </option>
              ))}
          </select>
        </label>
        <label>
          Поиск
          <input
            value={query}
            placeholder="Имя, направление, город"
            onChange={(event) => setQuery(event.target.value)}
          />
        </label>
        <button
          className="secondary-button"
          type="button"
          disabled={loading || saving}
          onClick={() => void load()}
        >
          Обновить
        </button>
      </div>
      {notice !== null && (
        <p className="review-notice" role="status">
          {notice}
        </p>
      )}
      {error !== null && (
        <p className="review-error" role="alert">
          {error}
        </p>
      )}
      <div className="review-layout" aria-busy={loading}>
        <section aria-label="Список заявок" className="review-list">
          {loading ? (
            <p role="status">Загружаем заявки…</p>
          ) : visible.length === 0 ? (
            <p>{query ? 'По запросу ничего не найдено.' : 'В этой категории пока нет заявок.'}</p>
          ) : (
            visible.map((item) => (
              <button
                key={item.id}
                className={`review-row${selectedId === item.id ? ' is-selected' : ''}`}
                type="button"
                disabled={saving}
                aria-pressed={selectedId === item.id}
                onClick={() => {
                  setSelectedId(item.id);
                  setAction(null);
                  setReason('');
                  setError(null);
                }}
              >
                <span className="review-avatar" aria-hidden="true">
                  {Array.from(item.display_name ?? 'Т')[0]}
                </span>
                <span>
                  <strong>{item.display_name ?? 'Кандидат'}</strong>
                  <span>{item.specialization}</span>
                  <small>
                    {item.city} · {item.experience_years ?? '—'} лет опыта
                  </small>
                </span>
                <span aria-hidden="true">↗</span>
              </button>
            ))
          )}
        </section>
        <section
          ref={detailRef}
          tabIndex={-1}
          className="review-detail"
          aria-label="Заявка кандидата"
        >
          {selected === undefined ? (
            <div className="review-empty">
              <KineticMark />
              <h2>Выберите заявку</h2>
              <p>Здесь появятся опыт и подготовка кандидата, а также ссылки, если он их добавил.</p>
            </div>
          ) : (
            <>
              <p className="program-kicker">{labels[selected.status]}</p>
              <h2>{selected.display_name}</h2>
              <p>
                {selected.specialization} · {selected.city}
              </p>
              <p className="review-bio">{selected.bio}</p>
              <dl className="review-facts">
                <div>
                  <dt>Опыт</dt>
                  <dd>{selected.experience_years ?? '—'} лет</dd>
                </div>
                <div>
                  <dt>Часовой пояс</dt>
                  <dd>{selected.timezone}</dd>
                </div>
                <div>
                  <dt>Подана</dt>
                  <dd>
                    {new Date(selected.submitted_at ?? selected.created_at).toLocaleDateString(
                      'ru-RU',
                    )}
                  </dd>
                </div>
              </dl>
              <h3>Материалы</h3>
              {selected.materials.length === 0 ? (
                <p>
                  Кандидат подал заявку без ссылок. Проверьте описание подготовки; при необходимости
                  запросите уточнения.
                </p>
              ) : null}
              <ul className="review-materials">
                {selected.materials.map((material) => (
                  <li key={material.id}>
                    <a href={material.url} target="_blank" rel="noopener noreferrer">
                      {material.title} ↗
                    </a>
                    {material.expires_at !== null && (
                      <small>
                        Действует до {new Date(material.expires_at).toLocaleDateString('ru-RU')}
                      </small>
                    )}
                  </li>
                ))}
              </ul>
              {selected.review_reason !== null && (
                <p className="review-notice">Комментарий: {selected.review_reason}</p>
              )}
              {selected.user_id === accountId && (
                <p>Ваша заявка должна быть рассмотрена другим администратором.</p>
              )}
              {actionable && (
                <div className="review-actions">
                  {(Object.keys(actionLabels) as Action[]).map((key) => (
                    <button
                      key={key}
                      type="button"
                      className={key === 'approve' ? 'primary-button' : 'secondary-button'}
                      disabled={saving}
                      onClick={() => {
                        setAction(key);
                        setReason('');
                      }}
                    >
                      {actionLabels[key]}
                    </button>
                  ))}
                </div>
              )}
              {action !== null && actionable && (
                <form
                  className="review-confirm"
                  onSubmit={(event) => {
                    event.preventDefault();
                    void confirm();
                  }}
                >
                  <h3>{actionLabels[action]}?</h3>
                  <p>
                    {action === 'approve'
                      ? 'После подтверждения откроется кабинет тренера. Права администратора не выдаются.'
                      : 'Объясните кандидату, что нужно исправить. Комментарий появится в его заявке.'}
                  </p>
                  <label>
                    Комментарий {action === 'approve' ? '(необязательно)' : ''}
                    <textarea
                      value={reason}
                      maxLength={1000}
                      required={action !== 'approve'}
                      disabled={saving}
                      onChange={(event) => setReason(event.target.value)}
                    />
                  </label>
                  <div className="review-actions">
                    <button
                      className="primary-button"
                      type="submit"
                      disabled={saving || (action !== 'approve' && reason.trim() === '')}
                    >
                      {saving ? 'Сохраняем…' : 'Подтвердить решение'}
                    </button>
                    <button
                      className="secondary-button"
                      type="button"
                      disabled={saving}
                      onClick={() => setAction(null)}
                    >
                      Отмена
                    </button>
                  </div>
                </form>
              )}
            </>
          )}
        </section>
      </div>
    </main>
  );
};
