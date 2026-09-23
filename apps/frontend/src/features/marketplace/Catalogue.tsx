import React, { useEffect, useState } from 'react';
import {
  MARKET_DISCIPLINE_LABELS,
  MARKET_OFFER_LABELS,
  marketPrice,
  type MarketCatalogue,
  type MarketOffer,
  type MarketOfferInput,
  type MarketProfile,
  type MarketProfileInput,
} from '@kinetra/shared';
import { marketplaceApi } from './api';
import { appRoutes, type AppRoute } from '../../routing';
import { KineticMark } from '../navigation/KineticMark';
const levels = {
  beginner: 'Начинающий',
  intermediate: 'Есть опыт',
  advanced: 'Продвинутый',
  all: 'Любой уровень',
};
export const OfferContent = ({ offer }: { offer: MarketOfferInput }): React.ReactNode => (
  <>
    <div className="market-eyebrow">
      {MARKET_DISCIPLINE_LABELS[offer.discipline]} · {MARKET_OFFER_LABELS[offer.kind]}
    </div>
    <h1>{offer.title}</h1>
    <p className="market-lead">{offer.summary}</p>
    <div className="market-offer-price">
      <strong>{marketPrice(offer)}</strong>
      <span>
        Доступ на {offer.access_days} дней
        {offer.payment_period === 'month' ? ' в каждом оплаченном периоде' : ''}
      </span>
    </div>
    <div className="market-facts">
      <span>{levels[offer.level]}</span>
      <span>
        {offer.nutrition === 'none'
          ? 'Без плана питания'
          : offer.nutrition === 'general'
            ? 'Общий план питания'
            : 'Персональный план питания'}
      </span>
      {offer.capacity !== null && <span>Количество мест: {offer.capacity}</span>}
    </div>
    {[
      ['О программе', offer.description],
      ['Что входит', offer.includes],
      ['Кому подходит и что понадобится', offer.requirements],
      ['Как проходит работа', offer.feedback],
      ['Когда начнём', offer.start_policy],
      ['Отмена и перенос', offer.cancellation_terms],
    ].map(([title, text]) => (
      <section className="market-detail-section" key={title}>
        <h2>{title}</h2>
        <p>{text}</p>
      </section>
    ))}
    <section className="market-detail-section">
      <h2>Обратная связь</h2>
      <p>
        {offer.response_hours === null
          ? 'Личный ответ тренера не включён.'
          : `Обычный срок ответа — до ${offer.response_hours} ч.`}{' '}
        Проверок видео: {offer.video_reviews}. Встреч: {offer.meetings}.
      </p>
      {offer.application_required && <p>Перед оформлением требуется подтверждение тренера.</p>}
    </section>
    {offer.sample_text && (
      <section className="market-sample">
        <p className="market-eyebrow">Открытый образец</p>
        <h2>Попробуйте формат</h2>
        <p>{offer.sample_text}</p>
      </section>
    )}
  </>
);
export const ProfileContent = ({ profile }: { profile: MarketProfileInput }) => (
  <>
    <div className="market-avatar" aria-hidden="true">
      {profile.display_name.slice(0, 1)}
    </div>
    <p className="market-eyebrow">
      {profile.disciplines.map((v) => MARKET_DISCIPLINE_LABELS[v]).join(' · ')}
    </p>
    <h1>{profile.display_name}</h1>
    <p className="market-lead">{profile.headline}</p>
    <div className="market-facts">
      <span>{profile.city || 'Онлайн'}</span>
      <span>{profile.languages.join(' · ')}</span>
    </div>
    <section className="market-detail-section">
      <h2>Знакомство</h2>
      <p>{profile.bio}</p>
    </section>
    <section className="market-detail-section">
      <h2>Мой подход</h2>
      <p>{profile.approach}</p>
    </section>
    {profile.faq.map((f, i) => (
      <details className="market-faq" key={i}>
        <summary>{f.question}</summary>
        <p>{f.answer}</p>
      </details>
    ))}
  </>
);
const OfferCard = ({
  offer,
  onNavigate,
}: {
  offer: MarketOffer;
  onNavigate: (r: AppRoute) => void;
}) => (
  <button className="market-card" onClick={() => onNavigate(`/offers/${offer.id}`)}>
    <span className="market-eyebrow">{MARKET_DISCIPLINE_LABELS[offer.discipline]}</span>
    <h3>{offer.title}</h3>
    <p>{offer.summary}</p>
    <span>
      {offer.trainer_name} · {MARKET_OFFER_LABELS[offer.kind]}
    </span>
    <strong>
      {marketPrice(offer)} <span aria-hidden="true">↗</span>
    </strong>
  </button>
);
const ProfileCard = ({
  profile,
  onNavigate,
}: {
  profile: MarketProfile;
  onNavigate: (r: AppRoute) => void;
}) => (
  <button className="market-card" onClick={() => onNavigate(`/coaches/${profile.id}`)}>
    <span className="market-avatar" aria-hidden="true">
      {profile.display_name.slice(0, 1)}
    </span>
    <h3>{profile.display_name}</h3>
    <p>{profile.headline}</p>
    <span>{profile.disciplines.map((v) => MARKET_DISCIPLINE_LABELS[v]).join(' · ')}</span>
    <span>
      {profile.review_count
        ? `${profile.rating?.toFixed(1)} / 5 · оценок: ${profile.review_count}`
        : 'Оценок пока нет'}
    </span>
    <strong>
      Познакомиться <span aria-hidden="true">↗</span>
    </strong>
  </button>
);
export const Catalogue = ({
  route,
  onNavigate,
  authenticated = false,
}: {
  route: AppRoute;
  onNavigate: (r: AppRoute) => void;
  authenticated?: boolean;
}) => {
  const [query, setQuery] = useState(() => new URLSearchParams(window.location.search).toString());
  const [data, setData] = useState<MarketCatalogue | null>(null),
    [profile, setProfile] = useState<MarketProfile | null>(null),
    [offers, setOffers] = useState<MarketOffer[]>([]),
    [offer, setOffer] = useState<MarketOffer | null>(null);
  const [error, setError] = useState(''),
    [loading, setLoading] = useState(true),
    [retry, setRetry] = useState(0),
    [tab, setTab] = useState<'trainers' | 'offers'>('trainers');
  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    setError('');
    setProfile(null);
    setOffer(null);
    const path = route.split('/');
    const load = async () => {
      if (path[1] === 'coaches') {
        const value = await marketplaceApi.profile(path[2]!, controller.signal);
        if (!controller.signal.aborted) {
          setProfile(value.profile);
          setOffers(value.offers);
        }
      } else if (path[1] === 'offers') {
        const value = await marketplaceApi.offer(path[2]!, controller.signal);
        if (!controller.signal.aborted) setOffer(value.offer);
      } else {
        const value = await marketplaceApi.catalogue(query, controller.signal);
        if (!controller.signal.aborted) setData(value);
      }
    };
    void load()
      .catch((e) => {
        if (!controller.signal.aborted)
          setError(e instanceof Error ? e.message : 'Не удалось загрузить каталог.');
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [route, query, retry]);
  const setSearch = (next: URLSearchParams) => {
    setQuery(next.toString());
    window.history.replaceState(
      window.history.state,
      '',
      `${route}${next.size ? '?' + next.toString() : ''}`,
    );
  };
  return (
    <main className="market-page" data-testid="market-catalogue">
      <header className="market-header">
        <button
          className="market-brand"
          onClick={() => onNavigate(appRoutes.catalogue)}
          aria-label="Kinetra — каталог"
        >
          <KineticMark />
          <strong>KINETRA</strong>
        </button>
        <button
          className="secondary-button"
          onClick={() => {
            if (!authenticated) {
              try {
                sessionStorage.setItem('kinetra-market-return', route);
              } catch {
                /* Browsing remains available without storage. */
              }
            }
            onNavigate(authenticated ? appRoutes.home : appRoutes.login);
          }}
        >
          {authenticated ? 'К занятиям' : 'Войти'}
        </button>
      </header>
      {route !== appRoutes.catalogue && (
        <button className="market-back" onClick={() => onNavigate(appRoutes.catalogue)}>
          ← Каталог
        </button>
      )}
      {route === appRoutes.catalogue && (
        <>
          <section className="market-hero">
            <p className="market-eyebrow">Ваш спорт. Ваш тренер.</p>
            <h1>
              Начните с человека,
              <br />
              который вас понимает.
            </h1>
            <p className="market-lead">
              Программы, занятия и поддержка тренеров. Выберите подходящий формат и познакомьтесь с
              автором.
            </p>
            <span className="market-mode">Закрытый запуск · покупки пока недоступны</span>
          </section>
          <form
            key={query}
            className="market-filters"
            onSubmit={(e) => {
              e.preventDefault();
              const form = new FormData(e.currentTarget),
                next = new URLSearchParams();
              for (const [k, v] of form) if (String(v)) next.set(k, String(v));
              setSearch(next);
            }}
          >
            <label>
              Поиск
              <input
                name="q"
                placeholder="Имя, программа или цель"
                maxLength={100}
                defaultValue={new URLSearchParams(query).get('q') ?? ''}
              />
            </label>
            <label>
              Дисциплина
              <select
                name="discipline"
                defaultValue={new URLSearchParams(query).get('discipline') ?? ''}
              >
                <option value="">Все направления</option>
                {(data?.disciplines ?? []).map((d) => (
                  <option key={d} value={d}>
                    {MARKET_DISCIPLINE_LABELS[d]}
                  </option>
                ))}
              </select>
            </label>
            <label>
              Формат
              <select name="kind" defaultValue={new URLSearchParams(query).get('kind') ?? ''}>
                <option value="">Все форматы</option>
                {Object.entries(MARKET_OFFER_LABELS).map(([k, v]) => (
                  <option key={k} value={k}>
                    {v}
                  </option>
                ))}
              </select>
            </label>
            <label>
              Уровень
              <select name="level" defaultValue={new URLSearchParams(query).get('level') ?? ''}>
                <option value="">Все уровни</option>
                {Object.entries(levels).map(([k, v]) => (
                  <option key={k} value={k}>
                    {v}
                  </option>
                ))}
              </select>
            </label>
            <label>
              Оплата
              <select name="period" defaultValue={new URLSearchParams(query).get('period') ?? ''}>
                <option value="">Любой период</option>
                <option value="once">Разово</option>
                <option value="month">В месяц</option>
              </select>
            </label>
            <button className="primary-button">Найти</button>
            <button
              type="reset"
              className="secondary-button"
              onClick={() => setSearch(new URLSearchParams())}
            >
              Сбросить
            </button>
          </form>
          <div className="market-switch" aria-label="Показать">
            <button aria-pressed={tab === 'trainers'} onClick={() => setTab('trainers')}>
              Тренеры
            </button>
            <button aria-pressed={tab === 'offers'} onClick={() => setTab('offers')}>
              Предложения
            </button>
          </div>
        </>
      )}
      {loading ? (
        <p role="status">Загружаем…</p>
      ) : error ? (
        <div role="alert">
          <p>{error}</p>
          <button className="secondary-button" onClick={() => setRetry((v) => v + 1)}>
            Повторить
          </button>
        </div>
      ) : (
        <>
          {profile && (
            <>
              <ProfileContent profile={profile} />
              <h2>Предложения тренера</h2>
              <div className="market-grid">
                {offers.map((o) => (
                  <OfferCard key={o.id} offer={o} onNavigate={onNavigate} />
                ))}
              </div>
              {!offers.length && <p>Тренер ещё готовит свои предложения.</p>}
            </>
          )}
          {offer && (
            <>
              <button
                className="market-author"
                onClick={() => onNavigate(`/coaches/${offer.trainer_id}`)}
              >
                Тренер: {offer.trainer_name} ↗
              </button>
              <OfferContent offer={offer} />
              <aside className="market-purchase">
                <strong>Оформление покупок ещё не открыто</strong>
                <p>Условия можно изучить. Деньги не списываются, платный доступ не выдаётся.</p>
              </aside>
            </>
          )}
          {route === appRoutes.catalogue && data && (
            <>
              <div className="market-grid">
                {tab === 'trainers'
                  ? data.trainers.map((p) => (
                      <ProfileCard key={p.id} profile={p} onNavigate={onNavigate} />
                    ))
                  : data.offers.map((o) => (
                      <OfferCard key={o.id} offer={o} onNavigate={onNavigate} />
                    ))}
              </div>
              {(tab === 'trainers' ? data.trainers : data.offers).length === 0 && (
                <section className="market-empty">
                  <h2>{query ? 'Ничего не найдено' : 'Здесь появятся тренеры и их программы'}</h2>
                  <p>
                    {query
                      ? 'Попробуйте изменить фильтры.'
                      : 'Каталог готовится к закрытому запуску. Уже подключённые ученики могут продолжать занятия по приглашению.'}
                  </p>
                </section>
              )}
              <div className="market-pagination">
                {data.page > 1 && (
                  <button
                    className="secondary-button"
                    onClick={() => {
                      const next = new URLSearchParams(query);
                      next.set('page', String(data.page - 1));
                      setSearch(next);
                    }}
                  >
                    ← Назад
                  </button>
                )}
                {data.has_more && (
                  <button
                    className="secondary-button"
                    onClick={() => {
                      const next = new URLSearchParams(query);
                      next.set('page', String(data.page + 1));
                      setSearch(next);
                    }}
                  >
                    Далее →
                  </button>
                )}
              </div>
            </>
          )}
        </>
      )}
    </main>
  );
};
