import { useEffect, useState } from 'react';
import {
  COACH_LEVELS,
  COACH_PACKAGES,
  coachPackageQuote,
  type CoachProfile,
} from '@kinetra/shared';
import { trainingApi, trainingMessage } from './api';
const rub = (value: number) => `${value.toLocaleString('ru-RU')} ₽`;
const LevelCard = ({ profile }: { profile: CoachProfile }) => (
  <section className="training-card coach-level-card">
    <p className="survey-kicker">УРОВЕНЬ ТРЕНЕРА</p>
    <h2>
      {profile.display_name} <span className="training-badge">{profile.level}</span>
    </h2>
    <div className="coach-metrics">
      <div>
        <strong>{profile.active_students}</strong>
        <span>активных учеников</span>
      </div>
      <div>
        <strong>{profile.ready_lessons}</strong>
        <span>готовых видеоуроков</span>
      </div>
      <div>
        <strong>
          {profile.rating === null
            ? '—'
            : profile.rating.toLocaleString('ru-RU', { maximumFractionDigits: 1 }) + ' / 5'}
        </strong>
        <span>
          {profile.review_count ? `оценок учеников: ${profile.review_count}` : 'оценок пока нет'}
        </span>
      </div>
    </div>
    <p className="training-muted">
      Уровень отражает активность в Kinetra и оценки учеников. Проверка квалификации тренера
      проводится отдельно.
    </p>
    <details>
      <summary>
        {profile.next_level ? `Как достичь уровня «${profile.next_level}»` : 'Условия уровней'}
      </summary>
      <div className="coach-level-list">
        {COACH_LEVELS.map((l) => (
          <div key={l.name}>
            <strong>{l.name}</strong>
            <span>
              {l.students === 0
                ? 'Начало работы на платформе'
                : `От ${l.students} учеников · ${l.lessons} готовых уроков · ${l.reviews} оценок · средняя от ${l.rating.toLocaleString('ru-RU')}`}
            </span>
          </div>
        ))}
      </div>
      <p className="training-muted">
        Приглашения без подключения и архивные ученики не учитываются. Каждый ученик оставляет одну
        обновляемую оценку после выполненного занятия. Архивация ученика не удаляет его оценку.
      </p>
    </details>
  </section>
);
export const MyCoachCard = () => {
  const [data, setData] = useState<Awaited<ReturnType<typeof trainingApi.myCoach>> | null>(null),
    [score, setScore] = useState(0),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(''),
    [notice, setNotice] = useState(''),
    [revision, setRevision] = useState(0);
  useEffect(() => {
    let active = true;
    void trainingApi
      .myCoach()
      .then((v) => {
        if (active) {
          setData(v);
          setScore(v.score ?? 0);
          setError('');
        }
      })
      .catch((e) => {
        if (active) setError(trainingMessage(e));
      });
    return () => {
      active = false;
    };
  }, [revision]);
  if (!data?.profile)
    return error ? (
      <p role="alert">
        Не удалось загрузить уровень тренера.{' '}
        <button type="button" onClick={() => setRevision((v) => v + 1)}>
          Повторить
        </button>
      </p>
    ) : null;
  return (
    <>
      <LevelCard profile={data.profile} />
      <section className="training-card coach-review">
        <h2>Как вам тренировки?</h2>
        <p>Оцените понятность программы, уроков и обратной связи. Оценку можно изменить.</p>
        {data.can_review ? (
          <form
            onSubmit={(e) => {
              e.preventDefault();
              setBusy(true);
              setError('');
              void trainingApi
                .rateCoach(score)
                .then(() => {
                  setNotice('Оценка сохранена. Спасибо за обратную связь.');
                  setRevision((v) => v + 1);
                })
                .catch((e) => setError(trainingMessage(e)))
                .finally(() => setBusy(false));
            }}
          >
            <fieldset disabled={busy}>
              <legend>Ваша оценка</legend>
              <div className="coach-stars">
                {[1, 2, 3, 4, 5].map((v) => (
                  <label key={v} className={score === v ? 'is-selected' : ''}>
                    <input
                      type="radio"
                      name="coach-score"
                      value={v}
                      checked={score === v}
                      onChange={() => setScore(v)}
                    />
                    <span>{v} ★</span>
                  </label>
                ))}
              </div>
              <button className="primary-button" disabled={!score || busy}>
                {busy ? 'Сохраняем…' : data.score ? 'Обновить оценку' : 'Оценить'}
              </button>
            </fieldset>
          </form>
        ) : (
          <p className="training-muted">
            Оценка откроется после первого выполненного занятия или урока.
          </p>
        )}
        {notice && <p role="status">{notice}</p>}
        {error && <p role="alert">{error}</p>}
      </section>
    </>
  );
};
export const CoachProfileScreen = () => {
  const [profile, setProfile] = useState<CoachProfile | null>(null),
    [error, setError] = useState(''),
    [revision, setRevision] = useState(0),
    [plan, setPlan] = useState('start'),
    [base, setBase] = useState(30),
    [extra, setExtra] = useState(0);
  useEffect(() => {
    let active = true;
    void trainingApi
      .coachProfile()
      .then((v) => {
        if (active) {
          setProfile(v);
          setError('');
        }
      })
      .catch((e) => {
        if (active) setError(trainingMessage(e));
      });
    return () => {
      active = false;
    };
  }, [revision]);
  const quote = coachPackageQuote(plan, base, extra),
    selected = COACH_PACKAGES.find((p) => p.id === plan)!;
  return (
    <main className="training-workspace coach-profile" data-testid="coach-profile">
      <p className="survey-kicker">ВАША ПРАКТИКА</p>
      <h1>Профиль и пакеты</h1>
      {error ? (
        <p role="alert">
          {error}{' '}
          <button type="button" onClick={() => setRevision((v) => v + 1)}>
            Повторить
          </button>
        </p>
      ) : profile ? (
        <LevelCard profile={profile} />
      ) : (
        <p role="status">Загружаем профиль…</p>
      )}
      <section className="training-card coach-pricing">
        <div className="training-heading">
          <div>
            <p className="survey-kicker">БОЛЬШЕ УЧЕНИКОВ — ВЫГОДНЕЕ</p>
            <h2>Рассчитайте свой пакет</h2>
          </div>
          <span className="training-badge">Сейчас бесплатная бета</span>
        </div>
        <p>
          Платежи пока не подключены. Калькулятор показывает будущую стоимость; выбор пакета ничего
          не списывает и не ограничивает доступ.
        </p>
        <div className="coach-packages">
          {COACH_PACKAGES.map((p) => (
            <button
              type="button"
              key={p.id}
              aria-pressed={plan === p.id}
              onClick={() => {
                setPlan(p.id);
                setExtra(0);
              }}
            >
              <span>{p.name}</span>
              <strong>{p.id === 'large' ? 'От 30' : p.seats} учеников</strong>
              <b>
                {rub(p.perSeat)} <small>за ученика / мес.</small>
              </b>
              <span>
                {p.id === 'large' ? 'От ' : ''}
                {rub(p.seats * p.perSeat)} / мес.
              </span>
              <span>Доп. место — {rub(p.extraSeat)}</span>
            </button>
          ))}
        </div>
        <div className="training-fields">
          {plan === 'large' && (
            <label>
              Мест в большом пакете
              <input
                type="number"
                min={30}
                max={500}
                step={1}
                value={base}
                onChange={(e) =>
                  setBase(
                    Math.max(30, Math.min(500 - extra, Math.trunc(Number(e.target.value) || 30))),
                  )
                }
              />
            </label>
          )}
          <label>
            Дополнительные места · по {rub(selected.extraSeat)}
            <input
              type="number"
              min={0}
              max={500 - (plan === 'large' ? base : selected.seats)}
              step={1}
              value={extra}
              onChange={(e) =>
                setExtra(
                  Math.max(
                    0,
                    Math.min(
                      500 - (plan === 'large' ? base : selected.seats),
                      Math.trunc(Number(e.target.value) || 0),
                    ),
                  ),
                )
              }
            />
          </label>
        </div>
        <div className="coach-quote" aria-live="polite">
          <span>{quote.seats} мест для учеников</span>
          <strong>
            {rub(quote.monthly)} <small>/ месяц</small>
          </strong>
          <span>
            Первые 3 платных месяца со скидкой 40%: <b>{rub(quote.introductory)} / мес.</b>
          </span>
          <span>Затем — {rub(quote.monthly)} / мес.</span>
        </div>
        <p className="training-muted">
          План запуска: 14 дней полного доступа с первого входа после одобрения заявки, затем 3
          платных месяца со скидкой. Пока пробный таймер не запущен. Доступ учеников к вашим урокам
          и чату включён.
        </p>
        <p className="training-muted">
          Считаются подключённые неархивные ученики. Для большого пакета места, выбранные на месяц
          заранее, стоят по 130 ₽; отдельные дополнительные места — по 150 ₽. Перед оплатой будет
          показана полная сумма.
        </p>
      </section>
    </main>
  );
};
