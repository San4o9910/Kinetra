import React, { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import {
  MARKET_DISCIPLINE_LABELS,
  MARKET_OFFER_LABELS,
  marketPrice,
  type MarketDraft,
  type MarketOfferInput,
  type MarketProfileInput,
  type MarketReviewItem,
} from '@kinetra/shared';
import { marketplaceApi } from './api';
import { OfferContent, ProfileContent } from './Catalogue';
import { draftKey, readDraft, writeDraft, removeDraft } from '../training/drafts';
import { appRoutes, type AppRoute } from '../../routing';
const status = {
  draft: 'Черновик',
  pending: 'На проверке',
  approved: 'Одобрено',
  changes_requested: 'Нужны изменения',
  suspended: 'Приостановлено модератором',
};
const message = (e: unknown) =>
  e instanceof Error ? e.message : 'Не удалось сохранить. Повторите попытку.';
const emptyOffer: MarketOfferInput = {
  title: 'Новое предложение',
  summary: '',
  description: '',
  discipline: 'swimming',
  kind: 'program',
  level: 'beginner',
  price_kopecks: 0,
  payment_period: 'once',
  access_days: 30,
  start_policy: '',
  includes: '',
  requirements: '',
  feedback: '',
  nutrition: 'none',
  response_hours: null,
  video_reviews: 0,
  meetings: 0,
  capacity: null,
  application_required: false,
  cancellation_terms: '',
  sample_text: '',
};
const emptyProfile = (name: string): MarketProfileInput => ({
  display_name: name || 'Тренер',
  headline: '',
  bio: '',
  city: '',
  approach: '',
  disciplines: ['swimming'],
  languages: ['Русский'],
  faq: [],
});

function useMarketDraft<T extends object>(
  account: string,
  kind: string,
  id: string,
  initial: T,
  revision: number,
) {
  const key = draftKey(account, `market-${kind}`, id);
  const stored = useRef(readDraft<{ revision: number; content: T }>(key));
  const valid =
    stored.current &&
    typeof stored.current.revision === 'number' &&
    stored.current.content &&
    typeof stored.current.content === 'object' &&
    Object.keys(initial).every((k) => k in stored.current!.content) &&
    JSON.stringify(stored.current.content) !== JSON.stringify(initial);
  const [draft, setDraft] = useState<T>(valid ? stored.current!.content : initial);
  const baseRevision = valid ? stored.current!.revision : revision;
  useEffect(() => {
    writeDraft(key, { revision: baseRevision, content: draft });
  }, [draft, key, baseRevision]);
  return {
    draft,
    setDraft,
    baseRevision,
    conflict: baseRevision !== revision,
    clear: () => removeDraft(key),
    reload: () => {
      if (
        !window.confirm('Загрузить сохранённую версию? Местные несохранённые правки будут удалены.')
      )
        return;
      removeDraft(key);
      stored.current = null;
      setDraft(initial);
    },
  };
}
const TextField = ({
  label,
  value,
  onChange,
  max = 3000,
  short = false,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  max?: number;
  short?: boolean;
}) => (
  <label>
    {label}
    {short ? (
      <input value={value} maxLength={max} onChange={(e) => onChange(e.target.value)} />
    ) : (
      <textarea rows={4} value={value} maxLength={max} onChange={(e) => onChange(e.target.value)} />
    )}
  </label>
);
const DraftForm = ({
  children,
  onSave,
  onClose,
  error,
  busy,
  conflict,
  onReload,
}: {
  children: ReactNode;
  onSave: () => Promise<void>;
  onClose: () => void;
  error: string;
  busy: boolean;
  conflict: boolean;
  onReload: () => void;
}) => (
  <form
    className="market-editor"
    onSubmit={(e) => {
      e.preventDefault();
      void onSave();
    }}
  >
    {conflict && (
      <div role="alert">
        <p>
          На сервере уже другая версия. Ваш текст сохранён на этом устройстве; скопируйте нужные
          правки перед загрузкой свежей версии.
        </p>
        <button type="button" className="secondary-button" onClick={onReload}>
          Загрузить сохранённую версию
        </button>
      </div>
    )}
    <fieldset disabled={busy}>{children}</fieldset>
    {error && <p role="alert">{error}</p>}
    <div className="market-actions">
      <button className="primary-button" disabled={busy || conflict}>
        {busy ? 'Сохраняем…' : 'Сохранить черновик'}
      </button>
      <button type="button" className="secondary-button" disabled={busy} onClick={onClose}>
        К списку
      </button>
    </div>
  </form>
);
const ProfileEditor = ({
  account,
  name,
  row,
  onSaved,
  onClose,
}: {
  account: string;
  name: string;
  row: MarketDraft<MarketProfileInput> | null;
  onSaved: () => Promise<void>;
  onClose: () => void;
}) => {
  const local = useMarketDraft(
      account,
      'profile',
      account,
      row?.draft ?? emptyProfile(name),
      row?.revision ?? 0,
    ),
    { draft, setDraft } = local;
  const [busy, setBusy] = useState(false),
    [error, setError] = useState(''),
    [preview, setPreview] = useState(false);
  const set = <K extends keyof MarketProfileInput>(key: K, value: MarketProfileInput[K]) =>
    setDraft((v) => ({ ...v, [key]: value }));
  const save = async () => {
    setBusy(true);
    setError('');
    try {
      await marketplaceApi.saveProfile(draft, local.baseRevision);
      local.clear();
      await onSaved();
    } catch (e) {
      setError(message(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <>
      <div className="market-heading">
        <div>
          <p className="market-eyebrow">Витрина тренера</p>
          <h1>Расскажите о своей работе</h1>
        </div>
        <button className="secondary-button" onClick={() => setPreview((v) => !v)}>
          {preview ? 'Редактировать' : 'Предпросмотр'}
        </button>
      </div>
      {preview ? (
        <section className="market-preview">
          <p className="market-mode">Предпросмотр черновика · посетителям не виден</p>
          <ProfileContent profile={draft} />
        </section>
      ) : (
        <DraftForm
          onSave={save}
          onClose={onClose}
          error={error}
          busy={busy}
          conflict={local.conflict}
          onReload={local.reload}
        >
          <TextField
            label="Имя на витрине"
            value={draft.display_name}
            onChange={(v) => set('display_name', v)}
            max={120}
            short
          />
          <TextField
            label="Чем вы помогаете ученикам — одной фразой"
            value={draft.headline}
            onChange={(v) => set('headline', v)}
            max={160}
            short
          />
          <TextField
            label="О себе и опыте"
            value={draft.bio}
            onChange={(v) => set('bio', v)}
            max={5000}
          />
          <TextField
            label="Ваш подход к занятиям"
            value={draft.approach}
            onChange={(v) => set('approach', v)}
          />
          <TextField
            label="Город, если проводите очные занятия"
            value={draft.city}
            onChange={(v) => set('city', v)}
            max={120}
            short
          />
          <div className="market-checkboxes">
            <span>Направления</span>
            {Object.entries(MARKET_DISCIPLINE_LABELS).map(([k, v]) => (
              <label key={k}>
                <input
                  type="checkbox"
                  checked={draft.disciplines.includes(k as never)}
                  onChange={(e) =>
                    set(
                      'disciplines',
                      e.target.checked
                        ? [...draft.disciplines, k as MarketProfileInput['disciplines'][number]]
                        : draft.disciplines.filter((d) => d !== k),
                    )
                  }
                />
                {v}
              </label>
            ))}
          </div>
          <TextField
            label="Языки — через запятую"
            value={draft.languages.join(', ')}
            onChange={(v) =>
              set(
                'languages',
                v.split(',').map((x) => x.trim()),
              )
            }
            max={200}
            short
          />
          <h2>Ответы на частые вопросы</h2>
          {draft.faq.map((item, i) => (
            <div className="market-faq-editor" key={i}>
              <TextField
                label={`Вопрос ${i + 1}`}
                value={item.question}
                onChange={(v) =>
                  set(
                    'faq',
                    draft.faq.map((x, j) => (j === i ? { ...x, question: v } : x)),
                  )
                }
                max={200}
                short
              />
              <TextField
                label="Ответ"
                value={item.answer}
                onChange={(v) =>
                  set(
                    'faq',
                    draft.faq.map((x, j) => (j === i ? { ...x, answer: v } : x)),
                  )
                }
                max={1500}
              />
              <button
                type="button"
                className="secondary-button"
                onClick={() =>
                  set(
                    'faq',
                    draft.faq.filter((_, j) => j !== i),
                  )
                }
              >
                Удалить вопрос
              </button>
            </div>
          ))}
          {draft.faq.length < 10 && (
            <button
              type="button"
              className="secondary-button"
              onClick={() =>
                set('faq', [...draft.faq, { question: 'Новый вопрос', answer: 'Ответ' }])
              }
            >
              Добавить вопрос
            </button>
          )}
          <p className="market-muted">
            Личные контакты, документы и данные учеников сюда добавлять не нужно. Посетители увидят
            только проверенную версию.
          </p>
        </DraftForm>
      )}
    </>
  );
};
const OfferEditor = ({
  account,
  row,
  onSaved,
  onClose,
}: {
  account: string;
  row: MarketDraft<MarketOfferInput>;
  onSaved: () => Promise<void>;
  onClose: () => void;
}) => {
  const local = useMarketDraft(account, 'offer', row.id, row.draft, row.revision),
    { draft, setDraft } = local;
  const [step, setStep] = useState(0),
    [busy, setBusy] = useState(false),
    [error, setError] = useState('');
  const set = <K extends keyof MarketOfferInput>(key: K, value: MarketOfferInput[K]) =>
    setDraft((v) => ({ ...v, [key]: value }));
  const save = async () => {
    setBusy(true);
    setError('');
    try {
      await marketplaceApi.saveOffer(row.id, draft, local.baseRevision);
      local.clear();
      await onSaved();
    } catch (e) {
      setError(message(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <>
      <p className="market-eyebrow">Предложение тренера</p>
      <h1>{draft.title}</h1>
      <div className="market-steps" aria-label="Шаги создания">
        {['Формат', 'Состав', 'Поддержка', 'Цена и условия', 'Предпросмотр'].map((label, i) => (
          <button
            key={label}
            aria-current={step === i ? 'step' : undefined}
            onClick={() => setStep(i)}
          >
            {i + 1}. {label}
          </button>
        ))}
      </div>
      <DraftForm
        onSave={save}
        onClose={onClose}
        error={error}
        busy={busy}
        conflict={local.conflict}
        onReload={local.reload}
      >
        {step === 0 && (
          <>
            <TextField
              label="Название"
              value={draft.title}
              onChange={(v) => set('title', v)}
              max={160}
              short
            />
            <TextField
              label="Коротко о результате — без гарантий"
              value={draft.summary}
              onChange={(v) => set('summary', v)}
              max={300}
            />
            <label>
              Формат
              <select
                value={draft.kind}
                onChange={(e) => {
                  const kind = e.target.value as MarketOfferInput['kind'];
                  setDraft((v) => ({
                    ...v,
                    kind,
                    payment_period: kind === 'club' || kind === 'coaching' ? 'month' : 'once',
                  }));
                }}
              >
                {Object.entries(MARKET_OFFER_LABELS).map(([k, v]) => (
                  <option value={k} key={k}>
                    {v}
                  </option>
                ))}
              </select>
            </label>
            <label>
              Дисциплина
              <select
                value={draft.discipline}
                onChange={(e) =>
                  set('discipline', e.target.value as MarketOfferInput['discipline'])
                }
              >
                {Object.entries(MARKET_DISCIPLINE_LABELS).map(([k, v]) => (
                  <option value={k} key={k}>
                    {v}
                  </option>
                ))}
              </select>
            </label>
            <label>
              Опыт ученика
              <select
                value={draft.level}
                onChange={(e) => set('level', e.target.value as MarketOfferInput['level'])}
              >
                <option value="beginner">Начинающий</option>
                <option value="intermediate">Есть опыт</option>
                <option value="advanced">Продвинутый</option>
                <option value="all">Любой уровень</option>
              </select>
            </label>
            <TextField
              label="Кому подходит и что понадобится"
              value={draft.requirements}
              onChange={(v) => set('requirements', v)}
              max={2000}
            />
          </>
        )}
        {step === 1 && (
          <>
            <TextField
              label="Подробное описание"
              value={draft.description}
              onChange={(v) => set('description', v)}
              max={5000}
            />
            <TextField
              label="Что входит: занятия, материалы и ожидаемая работа"
              value={draft.includes}
              onChange={(v) => set('includes', v)}
            />
            <label>
              Питание в составе услуги
              <select
                value={draft.nutrition}
                onChange={(e) => set('nutrition', e.target.value as MarketOfferInput['nutrition'])}
              >
                <option value="none">Не входит</option>
                <option value="general">Общий план</option>
                <option value="personal">Персональный план</option>
              </select>
            </label>
            <TextField
              label="Открытый текстовый образец занятия — по желанию"
              value={draft.sample_text}
              onChange={(v) => set('sample_text', v)}
              max={5000}
            />
            <p className="market-muted">
              Образец будет общедоступным. Не вставляйте личные данные учеников.
            </p>
          </>
        )}
        {step === 2 && (
          <>
            <TextField
              label="Как проходит обратная связь"
              value={draft.feedback}
              onChange={(v) => set('feedback', v)}
              max={2000}
            />
            <label>
              Срок ответа, часы · пусто, если личные ответы не включены
              <input
                type="number"
                min={1}
                max={336}
                value={draft.response_hours ?? ''}
                onChange={(e) =>
                  set('response_hours', e.target.value ? Number(e.target.value) : null)
                }
              />
            </label>
            <label>
              Количество проверок видео
              <input
                type="number"
                min={0}
                max={100}
                value={draft.video_reviews}
                onChange={(e) => set('video_reviews', Number(e.target.value))}
              />
            </label>
            <label>
              Количество встреч
              <input
                type="number"
                min={0}
                max={100}
                value={draft.meetings}
                onChange={(e) => set('meetings', Number(e.target.value))}
              />
            </label>
            <label>
              Максимальное число учеников · пусто, если лимита нет
              <input
                type="number"
                min={1}
                max={500}
                value={draft.capacity ?? ''}
                onChange={(e) => set('capacity', e.target.value ? Number(e.target.value) : null)}
              />
            </label>
            <label className="market-checkbox">
              <input
                type="checkbox"
                checked={draft.application_required}
                onChange={(e) => set('application_required', e.target.checked)}
              />
              Сначала я подтверждаю заявку ученика
            </label>
          </>
        )}
        {step === 3 && (
          <>
            <label>
              Цена, ₽ {draft.payment_period === 'month' ? 'за месяц' : 'разово'}
              <input
                type="number"
                min={0}
                max={1000000}
                step="0.01"
                value={draft.price_kopecks / 100}
                onChange={(e) => set('price_kopecks', Math.round(Number(e.target.value) * 100))}
              />
            </label>
            <label>
              Срок доступа, дней {draft.payment_period === 'month' ? 'за каждый период' : ''}
              <input
                type="number"
                min={1}
                max={730}
                value={draft.access_days}
                onChange={(e) => set('access_days', Number(e.target.value))}
              />
            </label>
            <TextField
              label="Когда и как начинается работа"
              value={draft.start_policy}
              onChange={(v) => set('start_policy', v)}
              max={500}
            />
            <TextField
              label="Условия отмены, переноса и возврата"
              value={draft.cancellation_terms}
              onChange={(v) => set('cancellation_terms', v)}
            />
            <p className="market-mode">
              Комиссия ещё не утверждена. Сумма к получению тренером пока не рассчитывается.
              Реальные продажи выключены.
            </p>
          </>
        )}
        {step === 4 && (
          <section className="market-preview">
            <p className="market-mode">Предпросмотр · черновик виден только вам</p>
            <OfferContent offer={draft} />
          </section>
        )}
        <div className="market-actions">
          {step > 0 && (
            <button
              type="button"
              className="secondary-button"
              onClick={() => setStep((v) => v - 1)}
            >
              ← Назад
            </button>
          )}
          {step < 4 && (
            <button
              type="button"
              className="secondary-button"
              onClick={() => setStep((v) => v + 1)}
            >
              Далее →
            </button>
          )}
        </div>
      </DraftForm>
    </>
  );
};
export const MarketplaceWorkspace = ({
  account,
  name,
  onNavigate,
}: {
  account: string;
  name: string;
  onNavigate: (r: AppRoute) => void;
}): React.ReactNode => {
  const [data, setData] = useState<Awaited<ReturnType<typeof marketplaceApi.workspace>> | null>(
      null,
    ),
    [error, setError] = useState(''),
    [busy, setBusy] = useState(false),
    [notice, setNotice] = useState('');
  const [selected, setSelected] = useState<'profile' | string | null>(null);
  const load = useCallback(async () => {
    const result = await marketplaceApi.workspace();
    setData(result);
  }, []);
  useEffect(() => {
    let active = true;
    void marketplaceApi
      .workspace()
      .then((v) => {
        if (active) setData(v);
      })
      .catch((e) => {
        if (active) setError(message(e));
      });
    return () => {
      active = false;
    };
  }, []);
  const run = async (fn: () => Promise<unknown>, success = 'Готово') => {
    setBusy(true);
    setError('');
    setNotice('');
    try {
      await fn();
      await load();
      setNotice(success);
    } catch (e) {
      setError(message(e));
    } finally {
      setBusy(false);
    }
  };
  const saved = async () => {
    await load();
    setSelected(null);
    setNotice('Черновик сохранён. Перед публикацией отправьте его на проверку.');
  };
  const selectedOffer = data?.offers.find((o) => o.id === selected);
  return (
    <main className="market-page" data-testid="market-workspace">
      {selected === 'profile' && data ? (
        <ProfileEditor
          key={`profile-${data.profile?.revision ?? 0}`}
          account={account}
          name={name}
          row={data.profile}
          onSaved={saved}
          onClose={() => setSelected(null)}
        />
      ) : selectedOffer ? (
        <OfferEditor
          key={`${selectedOffer.id}-${selectedOffer.revision}`}
          account={account}
          row={selectedOffer}
          onSaved={saved}
          onClose={() => setSelected(null)}
        />
      ) : (
        <>
          <div className="market-heading">
            <div>
              <p className="market-eyebrow">Ваше пространство</p>
              <h1>Витрина и предложения</h1>
              <p className="market-lead">Расскажите о себе и соберите услуги по своей цене.</p>
            </div>
            <button className="secondary-button" onClick={() => onNavigate(appRoutes.catalogue)}>
              Открыть каталог ↗
            </button>
          </div>
          <p className="market-mode">Подготовка каталога. Реальные покупки и списания выключены.</p>
          {!data ? (
            <p role="status">{error ? 'Не удалось загрузить витрину.' : 'Загружаем…'}</p>
          ) : (
            <>
              <section className="market-owner-card">
                <div>
                  <p className="market-eyebrow">Публичный профиль</p>
                  <h2>{data.profile?.draft.display_name ?? name}</h2>
                  <p>
                    {data.profile ? status[data.profile.review_state] : 'Начните со знакомства'}
                  </p>
                  {data.profile?.review_note && <p>{data.profile.review_note}</p>}
                  {data.profile?.published && (
                    <p>
                      Посетителям{' '}
                      {data.profile.is_listed
                        ? 'видна последняя одобренная версия'
                        : 'витрина пока не видна'}
                      .
                    </p>
                  )}
                </div>
                <div className="market-actions">
                  <button
                    className="primary-button"
                    disabled={busy || data.profile?.review_state === 'suspended'}
                    onClick={() => setSelected('profile')}
                  >
                    {data.profile ? 'Редактировать' : 'Создать витрину'}
                  </button>
                  {data.profile && (
                    <>
                      <button
                        className="secondary-button"
                        disabled={
                          busy ||
                          data.profile.review_state === 'pending' ||
                          data.profile.review_state === 'suspended'
                        }
                        onClick={() =>
                          void run(
                            () => marketplaceApi.submit('profile', account, data.profile!.revision),
                            'Витрина отправлена на проверку',
                          )
                        }
                      >
                        На проверку
                      </button>
                      {data.profile.is_listed && (
                        <>
                          <button
                            className="secondary-button"
                            onClick={() => onNavigate(`/coaches/${account}`)}
                          >
                            Посмотреть
                          </button>
                          <button
                            className="secondary-button"
                            disabled={busy}
                            onClick={() =>
                              void run(
                                () =>
                                  marketplaceApi.pause('profile', account, data.profile!.revision),
                                'Витрина скрыта',
                              )
                            }
                          >
                            Скрыть
                          </button>
                        </>
                      )}
                    </>
                  )}
                </div>
              </section>
              <div className="market-heading">
                <h2>Мои предложения</h2>
                <button
                  className="primary-button"
                  disabled={busy}
                  onClick={() =>
                    void run(async () => {
                      const id = crypto.randomUUID();
                      await marketplaceApi.saveOffer(id, emptyOffer, 0);
                      setSelected(id);
                    }, 'Черновик создан')
                  }
                >
                  + Предложение
                </button>
              </div>
              {!data.offers.length && (
                <p className="market-empty">
                  Добавьте программу, сопровождение, клуб или занятия. Цену задаёте вы.
                </p>
              )}
              {data.offers.map((o) => (
                <section className="market-owner-card" key={o.id} data-market-offer={o.id}>
                  <div>
                    <p className="market-eyebrow">
                      {MARKET_OFFER_LABELS[o.draft.kind]} · {status[o.review_state]}
                    </p>
                    <h3>{o.draft.title}</h3>
                    <strong>{marketPrice(o.draft)}</strong>
                    {o.review_note && <p>{o.review_note}</p>}
                    {o.published && (
                      <p>
                        {o.is_listed
                          ? 'На витрине показана одобренная версия.'
                          : 'Предложение скрыто с витрины.'}
                      </p>
                    )}
                  </div>
                  <div className="market-actions">
                    <button
                      className="secondary-button"
                      disabled={busy || o.review_state === 'suspended'}
                      onClick={() => setSelected(o.id)}
                    >
                      Редактировать
                    </button>
                    <button
                      className="secondary-button"
                      disabled={
                        busy || o.review_state === 'pending' || o.review_state === 'suspended'
                      }
                      onClick={() =>
                        void run(
                          () => marketplaceApi.submit('offer', o.id, o.revision),
                          'Предложение отправлено на проверку',
                        )
                      }
                    >
                      На проверку
                    </button>
                    <button
                      className="secondary-button"
                      disabled={busy}
                      onClick={() =>
                        void run(async () => {
                          const id = crypto.randomUUID();
                          await marketplaceApi.saveOffer(
                            id,
                            { ...o.draft, title: `Копия: ${o.draft.title}`.slice(0, 160) },
                            0,
                          );
                          setSelected(id);
                        }, 'Создана независимая копия')
                      }
                    >
                      Дублировать
                    </button>
                    {o.is_listed && (
                      <>
                        <button
                          className="secondary-button"
                          onClick={() => onNavigate(`/offers/${o.id}`)}
                        >
                          Посмотреть
                        </button>
                        <button
                          className="secondary-button"
                          disabled={busy}
                          onClick={() =>
                            void run(
                              () => marketplaceApi.pause('offer', o.id, o.revision),
                              'Предложение скрыто',
                            )
                          }
                        >
                          Скрыть
                        </button>
                      </>
                    )}
                  </div>
                </section>
              ))}
            </>
          )}
        </>
      )}
      {notice && <p role="status">{notice}</p>}
      {error && (
        <div role="alert">
          <p>{error}</p>
          {!data && (
            <button className="secondary-button" onClick={() => void run(load)}>
              Повторить
            </button>
          )}
        </div>
      )}
    </main>
  );
};
export const MarketplaceReview = ({ onBack }: { onBack: () => void }) => {
  const [items, setItems] = useState<MarketReviewItem[]>([]),
    [selected, setSelected] = useState<MarketReviewItem | null>(null),
    [note, setNote] = useState(''),
    [error, setError] = useState(''),
    [busy, setBusy] = useState(false),
    [loaded, setLoaded] = useState(false);
  const load = useCallback(async () => {
    const v = await marketplaceApi.queue();
    setItems(v.items);
    setLoaded(true);
  }, []);
  useEffect(() => {
    let active = true;
    void marketplaceApi
      .queue()
      .then((v) => {
        if (active) {
          setItems(v.items);
          setLoaded(true);
        }
      })
      .catch((e) => {
        if (active) setError(message(e));
      });
    return () => {
      active = false;
    };
  }, []);
  const review = async (action: 'approve' | 'request_changes' | 'suspend') => {
    if (!selected) return;
    setBusy(true);
    setError('');
    try {
      await marketplaceApi.review(selected.entity, selected.id, selected.revision, action, note);
      await load();
      setSelected(null);
      setNote('');
    } catch (e) {
      setError(message(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <main className="market-page">
      <button className="secondary-button" onClick={onBack}>
        ← В кабинет
      </button>
      <p className="market-eyebrow">Модерация</p>
      <h1>Витрины и предложения</h1>
      {error && <p role="alert">{error}</p>}
      {!loaded && !error && <p role="status">Загружаем…</p>}
      {selected ? (
        <>
          <button className="secondary-button" disabled={busy} onClick={() => setSelected(null)}>
            ← К списку
          </button>
          <section className="market-preview">
            {selected.entity === 'profile' ? (
              <ProfileContent profile={selected.draft} />
            ) : (
              <OfferContent offer={selected.draft} />
            )}
          </section>
          <label>
            Причина решения
            <textarea value={note} maxLength={2000} onChange={(e) => setNote(e.target.value)} />
          </label>
          <div className="market-actions">
            <button
              className="primary-button"
              disabled={busy || selected.review_state !== 'pending'}
              onClick={() => void review('approve')}
            >
              Одобрить и опубликовать
            </button>
            <button
              className="secondary-button"
              disabled={busy || !note.trim()}
              onClick={() => void review('request_changes')}
            >
              Вернуть на доработку
            </button>
            <button
              className="secondary-button"
              disabled={busy || !note.trim()}
              onClick={() => void review('suspend')}
            >
              Приостановить
            </button>
          </div>
        </>
      ) : (
        <>
          {loaded && !items.length && (
            <p className="market-empty">Публикаций для проверки пока нет.</p>
          )}
          {items.map((i) => (
            <button
              className="market-review-row"
              key={`${i.entity}-${i.id}`}
              onClick={() => {
                setSelected(i);
                setNote('');
                setError('');
              }}
            >
              <span>
                {i.entity === 'profile' ? 'Витрина' : 'Предложение'} · {status[i.review_state]}
              </span>
              <strong>{i.entity === 'profile' ? i.draft.display_name : i.draft.title}</strong>
              <span>Открыть →</span>
            </button>
          ))}
        </>
      )}
    </main>
  );
};
