import { useEffect, useState, type ReactNode } from 'react';
import type { MeResponse, OnboardingStatus } from '@kinetra/shared';

import { SurveyWizard } from './features/survey/SurveyWizard';
import { ApiRequestError, fetchMe, readStoredAccessToken } from './lib/api';

type ViewMode = 'journey' | 'settings' | 'edit-survey';

const stageCopy: Record<
  Exclude<OnboardingStatus, 'survey_pending'>,
  { readonly eyebrow: string; readonly title: string; readonly description: string }
> = {
  onboarding_pending: {
    eyebrow: 'СЛЕДУЮЩИЙ ЭТАП · T05',
    title: 'Познакомимся с программой',
    description:
      'Анкета сохранена. Следующим экраном будет короткая карусель о подходе Kinetra.',
  },
  base_lessons: {
    eyebrow: 'БАЗОВЫЕ УРОКИ · T06',
    title: 'Подготовьте основу',
    description:
      'Здесь появятся семь базовых уроков, которые помогут безопасно начать программу.',
  },
  active: {
    eyebrow: 'ГЛАВНАЯ · T08',
    title: 'Ваше движение начинается здесь',
    description:
      'Главный экран будет показывать тренировку дня, прогресс недели и ключевые метрики.',
  },
};

interface JourneyPlaceholderProps {
  readonly profile: MeResponse;
  readonly onOpenSettings: () => void;
}

const JourneyPlaceholder = ({
  profile,
  onOpenSettings,
}: JourneyPlaceholderProps): ReactNode => {
  const status = profile.user.onboardingStatus;

  if (status === 'survey_pending') {
    return null;
  }

  const copy = stageCopy[status];

  return (
    <main className="app-shell">
      <section className="stage-card">
        <header className="stage-topbar">
          <div className="survey-brand">
            <span className="survey-brand-mark" aria-hidden="true">
              K
            </span>
            <span>KINETRA</span>
          </div>
          <button className="ghost-button" type="button" onClick={onOpenSettings}>
            Настройки
          </button>
        </header>

        <div className="stage-content">
          <p className="survey-kicker">{copy.eyebrow}</p>
          <h1>{copy.title}</h1>
          <p>{copy.description}</p>

          <div className="profile-summary">
            <span>Статус программы</span>
            <strong>{status}</strong>
            <span>Подписка</span>
            <strong>
              {profile.subscription.isActive ? 'Активна' : profile.subscription.status}
            </strong>
          </div>
        </div>
      </section>
    </main>
  );
};

interface SettingsProps {
  readonly profile: MeResponse;
  readonly onClose: () => void;
  readonly onEditSurvey: () => void;
}

const Settings = ({ profile, onClose, onEditSurvey }: SettingsProps): ReactNode => (
  <main className="app-shell">
    <section className="settings-card">
      <header className="stage-topbar">
        <div>
          <p className="survey-kicker">ПРОФИЛЬ</p>
          <h1>Настройки</h1>
        </div>
        <button className="ghost-button" type="button" onClick={onClose}>
          Закрыть
        </button>
      </header>

      <dl className="settings-list">
        <div>
          <dt>Имя</dt>
          <dd>{profile.user.firstName ?? profile.user.username ?? 'Не указано'}</dd>
        </div>
        <div>
          <dt>Email</dt>
          <dd>{profile.user.email ?? 'Не указан'}</dd>
        </div>
        <div>
          <dt>Статус</dt>
          <dd>{profile.user.onboardingStatus}</dd>
        </div>
        <div>
          <dt>Версия анкеты</dt>
          <dd>{profile.survey?.version ?? 'Не заполнена'}</dd>
        </div>
      </dl>

      <button
        className="primary-button settings-action"
        type="button"
        disabled={profile.survey === null}
        onClick={onEditSurvey}
      >
        Редактировать анкету
      </button>
    </section>
  </main>
);

const SessionRequired = (): ReactNode => (
  <main className="app-shell">
    <section className="stage-card session-card">
      <div className="survey-brand">
        <span className="survey-brand-mark" aria-hidden="true">
          K
        </span>
        <span>KINETRA</span>
      </div>
      <p className="survey-kicker">ЗАЩИЩЁННЫЙ ПРОФИЛЬ</p>
      <h1>Войдите в аккаунт</h1>
      <p>
        После авторизации Kinetra загрузит ваш профиль с сервера и продолжит с того этапа,
        на котором вы остановились.
      </p>
    </section>
  </main>
);

export const App = (): ReactNode => {
  const [profile, setProfile] = useState<MeResponse | null>(null);
  const [mode, setMode] = useState<ViewMode>('journey');
  const [isLoading, setIsLoading] = useState(readStoredAccessToken() !== null);
  const [loadError, setLoadError] = useState<string | null>(null);

  useEffect(() => {
    if (readStoredAccessToken() === null) {
      setIsLoading(false);
      return;
    }

    const controller = new AbortController();

    void fetchMe(controller.signal)
      .then((loadedProfile) => {
        setProfile(loadedProfile);
        setLoadError(null);
      })
      .catch((error: unknown) => {
        if (error instanceof DOMException && error.name === 'AbortError') {
          return;
        }

        setLoadError(
          error instanceof ApiRequestError
            ? error.message
            : 'Не удалось загрузить профиль. Проверьте подключение.',
        );
      })
      .finally(() => setIsLoading(false));

    return () => controller.abort();
  }, []);

  if (isLoading) {
    return (
      <main className="app-shell">
        <div className="loading-state" role="status">
          <span />
          Загружаем профиль…
        </div>
      </main>
    );
  }

  if (profile === null) {
    return (
      <>
        <SessionRequired />
        {loadError === null ? null : (
          <div className="global-error" role="alert">
            {loadError}
          </div>
        )}
      </>
    );
  }

  if (mode === 'edit-survey') {
    return (
      <SurveyWizard
        initialSurvey={profile.survey}
        onSaved={(updated) => {
          setProfile(updated);
          setMode('settings');
        }}
        onCancel={() => setMode('settings')}
      />
    );
  }

  if (mode === 'settings') {
    return (
      <Settings
        profile={profile}
        onClose={() => setMode('journey')}
        onEditSurvey={() => setMode('edit-survey')}
      />
    );
  }

  if (profile.user.onboardingStatus === 'survey_pending') {
    return (
      <SurveyWizard
        initialSurvey={profile.survey}
        onSaved={(updated) => {
          setProfile(updated);
          setMode('journey');
        }}
      />
    );
  }

  return <JourneyPlaceholder profile={profile} onOpenSettings={() => setMode('settings')} />;
};
