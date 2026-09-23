import { useEffect, useState } from 'react';
import { COACH_LEVELS, type CoachProfile } from '@kinetra/shared';
import { trainingApi, trainingMessage } from './api';
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
    [revision, setRevision] = useState(0);
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
  return (
    <main className="training-workspace coach-profile" data-testid="coach-profile">
      <p className="survey-kicker">ВАША ПРАКТИКА</p>
      <h1>Профиль тренера</h1>
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
      <section className="training-card">
        <h2>Ваши услуги — ваша цена</h2>
        <p>Программы, занятия и сопровождение создаются в разделе «Витрина и предложения».</p>
        <p>Сейчас действует бесплатный тестовый доступ. Покупки и списания пока не открыты.</p>
      </section>
    </main>
  );
};
