from __future__ import annotations

import json
from pathlib import Path

ROOT = Path.cwd()


def write(path: str, content: str) -> None:
    target = ROOT / path
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_text(content, encoding="utf-8")


write(
    "apps/frontend/src/lib/api.ts",
    r'''import type {
  ApiErrorResponse,
  AuthSessionResponse,
  HealthResponse,
  LoginRequest,
  MeResponse,
  SurveySubmission,
} from '@kinetra/shared';

export const apiBaseUrl = (import.meta.env.VITE_API_URL ?? 'http://localhost:3000').replace(
  /\/$/u,
  '',
);

let accessToken: string | null = null;
let refreshInFlight: Promise<AuthSessionResponse | null> | null = null;

export class ApiRequestError extends Error {
  public constructor(
    message: string,
    public readonly status: number,
    public readonly code: string,
  ) {
    super(message);
    this.name = 'ApiRequestError';
  }
}

export class ApiNetworkError extends Error {
  public constructor(message = 'Не удалось связаться с сервером. Проверьте подключение.') {
    super(message);
    this.name = 'ApiNetworkError';
  }
}

export const setAccessToken = (token: string): void => {
  accessToken = token;
};

export const clearAccessToken = (): void => {
  accessToken = null;
};

export const hasAccessToken = (): boolean => accessToken !== null;

export const resetSessionForTests = (): void => {
  accessToken = null;
  refreshInFlight = null;
};

const fetchSafely = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
  try {
    return await fetch(input, init);
  } catch (error) {
    if (error instanceof DOMException && error.name === 'AbortError') {
      throw error;
    }

    throw new ApiNetworkError();
  }
};

const readApiError = async (response: Response): Promise<ApiRequestError> => {
  let errorBody: ApiErrorResponse | null = null;

  try {
    errorBody = (await response.json()) as ApiErrorResponse;
  } catch {
    errorBody = null;
  }

  return new ApiRequestError(
    errorBody?.error.message ?? `Запрос завершился с ошибкой ${response.status}.`,
    response.status,
    errorBody?.error.code ?? 'REQUEST_FAILED',
  );
};

const readSessionResponse = async (response: Response): Promise<AuthSessionResponse> => {
  if (!response.ok) {
    throw await readApiError(response);
  }

  const session = (await response.json()) as AuthSessionResponse;
  setAccessToken(session.accessToken);
  return session;
};

export const loginSession = async (request: LoginRequest): Promise<AuthSessionResponse> => {
  const response = await fetchSafely(`${apiBaseUrl}/api/v1/auth/login`, {
    method: 'POST',
    credentials: 'include',
    headers: {
      Accept: 'application/json',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(request),
  });

  return readSessionResponse(response);
};

export const logoutSession = async (): Promise<void> => {
  try {
    const response = await fetchSafely(`${apiBaseUrl}/api/v1/auth/logout`, {
      method: 'POST',
      credentials: 'include',
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/json',
      },
      body: '{}',
    });

    if (!response.ok && response.status !== 401) {
      throw await readApiError(response);
    }
  } finally {
    clearAccessToken();
  }
};

export const refreshSession = async (): Promise<AuthSessionResponse | null> => {
  if (refreshInFlight !== null) {
    return refreshInFlight;
  }

  refreshInFlight = (async () => {
    const response = await fetchSafely(`${apiBaseUrl}/api/v1/auth/refresh`, {
      method: 'POST',
      credentials: 'include',
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/json',
      },
      body: '{}',
    });

    if (response.status === 401) {
      clearAccessToken();
      return null;
    }

    return readSessionResponse(response);
  })().finally(() => {
    refreshInFlight = null;
  });

  return refreshInFlight;
};

const noSessionError = (): ApiRequestError =>
  new ApiRequestError('Сессия не найдена. Войдите в аккаунт.', 401, 'NO_SESSION');

const authorizedFetch = async (
  path: string,
  init: RequestInit,
  token: string,
): Promise<Response> => {
  const headers = new Headers(init.headers);
  headers.set('Accept', 'application/json');
  headers.set('Authorization', `Bearer ${token}`);

  if (init.body !== undefined && init.body !== null) {
    headers.set('Content-Type', 'application/json');
  }

  return fetchSafely(`${apiBaseUrl}${path}`, {
    ...init,
    credentials: 'include',
    headers,
  });
};

const authenticatedJsonRequest = async <T>(
  path: string,
  init: RequestInit,
): Promise<T> => {
  let token = accessToken;

  if (token === null) {
    token = (await refreshSession())?.accessToken ?? null;
  }

  if (token === null) {
    throw noSessionError();
  }

  let response = await authorizedFetch(path, init, token);

  if (response.status === 401) {
    clearAccessToken();
    const refreshed = await refreshSession();

    if (refreshed === null) {
      throw noSessionError();
    }

    response = await authorizedFetch(path, init, refreshed.accessToken);
  }

  if (!response.ok) {
    throw await readApiError(response);
  }

  return (await response.json()) as T;
};

export const fetchHealth = async (signal: AbortSignal): Promise<HealthResponse> => {
  const response = await fetchSafely(`${apiBaseUrl}/health`, {
    headers: {
      Accept: 'application/json',
    },
    signal,
  });

  if (!response.ok) {
    throw new Error(`Health request failed with status ${response.status}.`);
  }

  return (await response.json()) as HealthResponse;
};

export const fetchMe = async (signal?: AbortSignal): Promise<MeResponse> =>
  authenticatedJsonRequest<MeResponse>('/api/v1/me', {
    method: 'GET',
    ...(signal === undefined ? {} : { signal }),
  });

export const saveSurvey = async (survey: SurveySubmission): Promise<MeResponse> =>
  authenticatedJsonRequest<MeResponse>('/api/v1/me/survey', {
    method: 'PUT',
    body: JSON.stringify(survey),
  });
''',
)

write(
    "apps/frontend/src/features/auth/LoginForm.tsx",
    r'''import { useState, type FormEvent, type ReactNode } from 'react';

interface LoginFormProps {
  readonly onLogin: (identifier: string, password: string) => Promise<void>;
}

export const LoginForm = ({ onLogin }: LoginFormProps): ReactNode => {
  const [identifier, setIdentifier] = useState('');
  const [password, setPassword] = useState('');
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const canSubmit = identifier.trim().length > 0 && password.length > 0 && !isSubmitting;

  const submit = async (event: FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault();

    if (!canSubmit) {
      return;
    }

    setIsSubmitting(true);
    setError(null);

    try {
      await onLogin(identifier.trim(), password);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Не удалось войти. Попробуйте ещё раз.');
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <form className="login-form" onSubmit={(event) => void submit(event)} noValidate>
      <label>
        <span>Email или телефон</span>
        <input
          autoComplete="username"
          inputMode="email"
          name="identifier"
          value={identifier}
          onChange={(event) => setIdentifier(event.target.value)}
          placeholder="name@example.com"
          required
        />
      </label>

      <label>
        <span>Пароль</span>
        <input
          autoComplete="current-password"
          name="password"
          type="password"
          value={password}
          onChange={(event) => setPassword(event.target.value)}
          required
        />
      </label>

      {error === null ? null : (
        <p className="survey-error" role="alert">
          {error}
        </p>
      )}

      <button className="primary-button" type="submit" disabled={!canSubmit}>
        {isSubmitting ? 'Входим…' : 'Войти'}
      </button>
    </form>
  );
};
''',
)

write(
    "apps/frontend/src/routing.ts",
    r'''import type { OnboardingStatus } from '@kinetra/shared';

export type ViewMode = 'journey' | 'settings' | 'edit-survey';
export type AppPath =
  | '/login'
  | '/survey'
  | '/onboarding'
  | '/base-lessons'
  | '/app'
  | '/settings'
  | '/settings/survey';

const onboardingPath: Record<OnboardingStatus, AppPath> = {
  survey_pending: '/survey',
  onboarding_pending: '/onboarding',
  base_lessons: '/base-lessons',
  active: '/app',
};

export const pathForStatus = (status: OnboardingStatus): AppPath => onboardingPath[status];

export const pathForView = (status: OnboardingStatus, mode: ViewMode): AppPath => {
  if (mode === 'settings') {
    return '/settings';
  }

  if (mode === 'edit-survey') {
    return '/settings/survey';
  }

  return pathForStatus(status);
};

export const modeFromPath = (pathname: string): ViewMode => {
  if (pathname === '/settings/survey') {
    return 'edit-survey';
  }

  if (pathname === '/settings') {
    return 'settings';
  }

  return 'journey';
};

export const replaceBrowserPath = (path: AppPath): void => {
  if (window.location.pathname !== path) {
    window.history.replaceState(null, '', path);
  }
};

export const pushBrowserPath = (path: AppPath): void => {
  if (window.location.pathname !== path) {
    window.history.pushState(null, '', path);
  }
};
''',
)

write(
    "apps/frontend/src/App.tsx",
    r'''import { useCallback, useEffect, useState, type ReactNode } from 'react';
import type { MeResponse, OnboardingStatus } from '@kinetra/shared';

import { LoginForm } from './features/auth/LoginForm';
import { SurveyWizard } from './features/survey/SurveyWizard';
import {
  ApiNetworkError,
  ApiRequestError,
  fetchMe,
  loginSession,
  logoutSession,
} from './lib/api';
import {
  modeFromPath,
  pathForStatus,
  pathForView,
  pushBrowserPath,
  replaceBrowserPath,
  type ViewMode,
} from './routing';

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

const JourneyPlaceholder = ({ profile, onOpenSettings }: JourneyPlaceholderProps): ReactNode => {
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
            <span className="survey-brand-mark" aria-hidden="true">K</span>
            <span>KINETRA</span>
          </div>
          <button className="ghost-button" type="button" onClick={onOpenSettings}>Настройки</button>
        </header>
        <div className="stage-content">
          <p className="survey-kicker">{copy.eyebrow}</p>
          <h1>{copy.title}</h1>
          <p>{copy.description}</p>
          <div className="profile-summary">
            <span>Статус программы</span>
            <strong>{status}</strong>
            <span>Подписка</span>
            <strong>{profile.subscription.isActive ? 'Активна' : profile.subscription.status}</strong>
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
  readonly onLogout: () => Promise<void>;
}

const Settings = ({ profile, onClose, onEditSurvey, onLogout }: SettingsProps): ReactNode => (
  <main className="app-shell">
    <section className="settings-card">
      <header className="stage-topbar">
        <div><p className="survey-kicker">ПРОФИЛЬ</p><h1>Настройки</h1></div>
        <button className="ghost-button" type="button" onClick={onClose}>Закрыть</button>
      </header>
      <dl className="settings-list">
        <div><dt>Имя</dt><dd>{profile.user.firstName ?? profile.user.username ?? 'Не указано'}</dd></div>
        <div><dt>Email</dt><dd>{profile.user.email ?? 'Не указан'}</dd></div>
        <div><dt>Статус</dt><dd>{profile.user.onboardingStatus}</dd></div>
        <div><dt>Версия анкеты</dt><dd>{profile.survey?.version ?? 'Не заполнена'}</dd></div>
      </dl>
      <div className="settings-actions">
        <button className="primary-button settings-action" type="button" disabled={profile.survey === null} onClick={onEditSurvey}>Редактировать анкету</button>
        <button className="secondary-button settings-action" type="button" onClick={() => void onLogout()}>Выйти</button>
      </div>
    </section>
  </main>
);

interface StatusCardProps {
  readonly kicker: string;
  readonly title: string;
  readonly description: string;
  readonly actionLabel?: string;
  readonly onAction?: () => void;
}

const StatusCard = ({ kicker, title, description, actionLabel, onAction }: StatusCardProps): ReactNode => (
  <main className="app-shell">
    <section className="stage-card session-card">
      <div className="survey-brand"><span className="survey-brand-mark" aria-hidden="true">K</span><span>KINETRA</span></div>
      <p className="survey-kicker">{kicker}</p>
      <h1>{title}</h1>
      <p>{description}</p>
      {actionLabel === undefined || onAction === undefined ? null : (
        <button className="primary-button status-action" type="button" onClick={onAction}>{actionLabel}</button>
      )}
    </section>
  </main>
);

const LoginScreen = ({ onLogin }: { readonly onLogin: (identifier: string, password: string) => Promise<void> }): ReactNode => (
  <main className="app-shell">
    <section className="stage-card session-card">
      <div className="survey-brand"><span className="survey-brand-mark" aria-hidden="true">K</span><span>KINETRA</span></div>
      <p className="survey-kicker">ЗАЩИЩЁННЫЙ ПРОФИЛЬ</p>
      <h1>Войдите в аккаунт</h1>
      <p>Kinetra восстановит защищённую сессию и продолжит с того этапа, на котором вы остановились.</p>
      <LoginForm onLogin={onLogin} />
    </section>
  </main>
);

type SessionState = 'loading' | 'authenticated' | 'unauthenticated' | 'offline' | 'error';

export const App = (): ReactNode => {
  const [profile, setProfile] = useState<MeResponse | null>(null);
  const [mode, setMode] = useState<ViewMode>(() => modeFromPath(window.location.pathname));
  const [sessionState, setSessionState] = useState<SessionState>('loading');
  const [loadError, setLoadError] = useState<string | null>(null);

  const loadProfile = useCallback(async (signal?: AbortSignal): Promise<void> => {
    setSessionState('loading');
    setLoadError(null);

    try {
      const loadedProfile = await fetchMe(signal);
      setProfile(loadedProfile);
      setSessionState('authenticated');
      replaceBrowserPath(pathForView(loadedProfile.user.onboardingStatus, modeFromPath(window.location.pathname)));
    } catch (error) {
      if (error instanceof DOMException && error.name === 'AbortError') return;
      setProfile(null);
      if (error instanceof ApiRequestError && error.status === 401) {
        setSessionState('unauthenticated');
        replaceBrowserPath('/login');
        return;
      }
      if (error instanceof ApiNetworkError || window.navigator.onLine === false) {
        setSessionState('offline');
        setLoadError(error instanceof Error ? error.message : null);
        return;
      }
      setSessionState('error');
      setLoadError(error instanceof Error ? error.message : 'Не удалось загрузить профиль.');
    }
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    void loadProfile(controller.signal);
    return () => controller.abort();
  }, [loadProfile]);

  useEffect(() => {
    const onPopState = (): void => setMode(modeFromPath(window.location.pathname));
    window.addEventListener('popstate', onPopState);
    return () => window.removeEventListener('popstate', onPopState);
  }, []);

  useEffect(() => {
    if (profile !== null && sessionState === 'authenticated') {
      replaceBrowserPath(pathForView(profile.user.onboardingStatus, mode));
    }
  }, [mode, profile, sessionState]);

  if (sessionState === 'loading') {
    return <main className="app-shell"><div className="loading-state" role="status"><span />Загружаем профиль…</div></main>;
  }

  if (sessionState === 'unauthenticated') {
    return <LoginScreen onLogin={async (identifier, password) => { await loginSession({ identifier, password }); await loadProfile(); }} />;
  }

  if (sessionState === 'offline') {
    return <StatusCard kicker="НЕТ СОЕДИНЕНИЯ" title="Профиль сохранён на сервере" description={loadError ?? 'Подключитесь к интернету и повторите загрузку.'} actionLabel="Повторить" onAction={() => void loadProfile()} />;
  }

  if (sessionState === 'error' || profile === null) {
    return <StatusCard kicker="ОШИБКА СЕРВЕРА" title="Не удалось загрузить профиль" description={loadError ?? 'Попробуйте ещё раз через несколько секунд.'} actionLabel="Повторить" onAction={() => void loadProfile()} />;
  }

  if (mode === 'edit-survey') {
    return <SurveyWizard initialSurvey={profile.survey} onSaved={(updated) => { setProfile(updated); setMode('settings'); replaceBrowserPath('/settings'); }} onCancel={() => { setMode('settings'); replaceBrowserPath('/settings'); }} />;
  }

  if (mode === 'settings') {
    return <Settings profile={profile} onClose={() => { setMode('journey'); pushBrowserPath(pathForStatus(profile.user.onboardingStatus)); }} onEditSurvey={() => { setMode('edit-survey'); pushBrowserPath('/settings/survey'); }} onLogout={async () => { try { await logoutSession(); } finally { setProfile(null); setMode('journey'); setSessionState('unauthenticated'); replaceBrowserPath('/login'); } }} />;
  }

  if (profile.user.onboardingStatus === 'survey_pending') {
    return <SurveyWizard initialSurvey={profile.survey} onSaved={(updated) => { setProfile(updated); setMode('journey'); replaceBrowserPath(pathForStatus(updated.user.onboardingStatus)); }} />;
  }

  return <JourneyPlaceholder profile={profile} onOpenSettings={() => { setMode('settings'); pushBrowserPath('/settings'); }} />;
};
''',
)

write(
    "apps/frontend/src/t04-hardening.css",
    r''':root,
body,
button,
input,
textarea {
  font-family: 'Inter Variable', Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
}

.login-form {
  display: grid;
  gap: 18px;
  margin-top: 28px;
  width: min(100%, 420px);
}

.login-form label {
  display: grid;
  gap: 8px;
  color: #a8b0ac;
  font-size: 0.875rem;
  font-weight: 600;
}

.login-form input {
  min-height: 48px;
  width: 100%;
  border: 1px solid rgba(244, 246, 242, 0.14);
  border-radius: 10px;
  background: #101313;
  color: #f4f6f2;
  font: inherit;
  padding: 0 14px;
  outline: none;
}

.login-form input:focus-visible {
  border-color: #c8f169;
  box-shadow: 0 0 0 3px rgba(200, 241, 105, 0.16);
}

.login-form .primary-button,
.status-action,
.settings-actions .settings-action {
  min-height: 48px;
  width: 100%;
}

.status-action {
  margin-top: 24px;
  max-width: 320px;
}

.settings-actions {
  display: grid;
  gap: 12px;
  margin-top: 24px;
}
''',
)

main_path = ROOT / "apps/frontend/src/main.tsx"
main_text = main_path.read_text(encoding="utf-8")
if "@fontsource-variable/inter" not in main_text:
    main_text = main_text.replace("import './styles.css';", "import '@fontsource-variable/inter';\nimport './styles.css';\nimport './t04-hardening.css';")
elif "./t04-hardening.css" not in main_text:
    main_text = main_text.replace("import './styles.css';", "import './styles.css';\nimport './t04-hardening.css';")
main_path.write_text(main_text, encoding="utf-8")

vite_env_path = ROOT / "apps/frontend/src/vite-env.d.ts"
vite_env = vite_env_path.read_text(encoding="utf-8")
if "declare module '@fontsource-variable/inter';" not in vite_env:
    vite_env += "\ndeclare module '@fontsource-variable/inter';\n"
vite_env_path.write_text(vite_env, encoding="utf-8")

write(
    "apps/backend/migrations/003_survey.sql",
    r'''CREATE OR REPLACE FUNCTION kinetra_text_array_is_unique(values_to_check text[])
RETURNS boolean
LANGUAGE sql
IMMUTABLE
STRICT
PARALLEL SAFE
AS $$
  SELECT cardinality(values_to_check) = COUNT(DISTINCT item)
  FROM unnest(values_to_check) AS items(item);
$$;

CREATE TABLE IF NOT EXISTS survey_answers (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL,
  version integer NOT NULL,
  gender varchar(16) NOT NULL,
  age_range varchar(16) NOT NULL,
  goal varchar(32) NOT NULL,
  injuries text[] NOT NULL,
  injuries_detail text NULL,
  experience varchar(32) NOT NULL,
  is_current boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT NOW(),
  updated_at timestamptz NOT NULL DEFAULT NOW(),
  CONSTRAINT survey_answers_user_fk FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
  CONSTRAINT survey_answers_user_version_unique UNIQUE (user_id, version),
  CONSTRAINT survey_answers_version_positive CHECK (version > 0),
  CONSTRAINT survey_answers_gender_valid CHECK (gender IN ('male', 'female')),
  CONSTRAINT survey_answers_age_range_valid CHECK (age_range IN ('18-25', '26-35', '36-45', '46-55', '55+')),
  CONSTRAINT survey_answers_goal_valid CHECK (goal IN ('flexibility', 'strength', 'awareness', 'general_health')),
  CONSTRAINT survey_answers_experience_valid CHECK (experience IN ('beginner', 'novice', 'experienced')),
  CONSTRAINT survey_answers_injuries_not_empty CHECK (cardinality(injuries) BETWEEN 1 AND 6),
  CONSTRAINT survey_answers_injuries_no_nulls CHECK (array_position(injuries, NULL) IS NULL),
  CONSTRAINT survey_answers_injuries_allowed CHECK (
    injuries <@ ARRAY['none', 'knees', 'lower_back', 'shoulders', 'neck', 'other']::text[]
  ),
  CONSTRAINT survey_answers_injuries_unique CHECK (kinetra_text_array_is_unique(injuries)),
  CONSTRAINT survey_answers_none_exclusive CHECK (NOT ('none' = ANY(injuries) AND cardinality(injuries) > 1)),
  CONSTRAINT survey_answers_other_detail_valid CHECK (
    ('other' = ANY(injuries) AND injuries_detail IS NOT NULL AND char_length(btrim(injuries_detail)) BETWEEN 1 AND 500)
    OR (NOT ('other' = ANY(injuries)) AND injuries_detail IS NULL)
  )
);

DROP TRIGGER IF EXISTS survey_answers_set_updated_at ON survey_answers;
CREATE TRIGGER survey_answers_set_updated_at
BEFORE UPDATE ON survey_answers
FOR EACH ROW
EXECUTE FUNCTION set_updated_at();

CREATE UNIQUE INDEX IF NOT EXISTS survey_answers_one_current_idx
  ON survey_answers (user_id)
  WHERE is_current = true;

CREATE INDEX IF NOT EXISTS survey_answers_user_history_idx
  ON survey_answers (user_id, version DESC);

CREATE INDEX IF NOT EXISTS survey_answers_current_lookup_idx
  ON survey_answers (user_id, created_at DESC)
  WHERE is_current = true;
''',
)

write(
    "apps/backend/test/survey-constraints.postgres.test.ts",
    r'''import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';

import pg from 'pg';

const databaseUrl = process.env.DATABASE_URL;
const { Pool } = pg;

const isCheckViolation = (error: unknown): boolean =>
  typeof error === 'object' && error !== null && 'code' in error && error.code === '23514';

test(
  'PostgreSQL survey constraints mirror Zod uniqueness and detail limits',
  { skip: databaseUrl === undefined },
  async () => {
    if (databaseUrl === undefined) return;

    const pool = new Pool({ connectionString: databaseUrl, max: 2 });
    const userId = randomUUID();

    try {
      await pool.query(
        `INSERT INTO users (id, email, password_hash, email_verified, onboarding_status)
         VALUES ($1, $2, $3, true, 'survey_pending')`,
        [userId, `survey-constraints-${userId}@example.com`, '$2b$10$abcdefghijklmnopqrstuv12345678901234567890123456789012'],
      );

      await assert.rejects(
        pool.query(
          `INSERT INTO survey_answers
             (user_id, version, gender, age_range, goal, injuries, experience, is_current)
           VALUES ($1, 1, 'female', '26-35', 'strength', ARRAY['knees', 'knees'], 'novice', false)`,
          [userId],
        ),
        isCheckViolation,
      );

      await assert.rejects(
        pool.query(
          `INSERT INTO survey_answers
             (user_id, version, gender, age_range, goal, injuries, injuries_detail, experience, is_current)
           VALUES ($1, 2, 'female', '26-35', 'strength', ARRAY['other'], $2, 'novice', false)`,
          [userId, 'x'.repeat(501)],
        ),
        isCheckViolation,
      );
    } finally {
      await pool.query('DELETE FROM users WHERE id = $1', [userId]);
      await pool.end();
    }
  },
);
''',
)

write(
    "apps/frontend/src/test/setup.ts",
    r'''import '@testing-library/jest-dom/vitest';
import { cleanup } from '@testing-library/react';
import { afterEach } from 'vitest';

import { resetSessionForTests } from '../lib/api';

afterEach(() => {
  cleanup();
  resetSessionForTests();
  window.history.replaceState(null, '', '/');
});
''',
)

write(
    "apps/frontend/vitest.config.ts",
    r'''import react from '@vitejs/plugin-react';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  plugins: [react()],
  test: {
    environment: 'jsdom',
    setupFiles: ['./src/test/setup.ts'],
    restoreMocks: true,
    clearMocks: true,
  },
});
''',
)

write(
    "apps/frontend/src/routing.test.ts",
    r'''import { describe, expect, it } from 'vitest';

import { modeFromPath, pathForStatus, pathForView } from './routing';

describe('server-driven onboarding routing', () => {
  it.each([
    ['survey_pending', '/survey'],
    ['onboarding_pending', '/onboarding'],
    ['base_lessons', '/base-lessons'],
    ['active', '/app'],
  ] as const)('maps %s to %s', (status, path) => {
    expect(pathForStatus(status)).toBe(path);
  });

  it('keeps settings paths independent from onboarding stage', () => {
    expect(pathForView('active', 'settings')).toBe('/settings');
    expect(pathForView('base_lessons', 'edit-survey')).toBe('/settings/survey');
    expect(modeFromPath('/settings')).toBe('settings');
    expect(modeFromPath('/settings/survey')).toBe('edit-survey');
  });
});
''',
)

write(
    "apps/frontend/src/lib/api.test.ts",
    r'''import type { AuthSessionResponse, MeResponse } from '@kinetra/shared';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  ApiNetworkError,
  ApiRequestError,
  fetchMe,
  hasAccessToken,
  loginSession,
  resetSessionForTests,
  setAccessToken,
} from './api';

const session: AuthSessionResponse = {
  user: { id: '00000000-0000-4000-8000-000000000001', email: 'user@example.com', phone: null, emailVerified: true, createdAt: '2026-08-20T00:00:00.000Z' },
  accessToken: 'access-token-new',
  tokenType: 'Bearer',
  expiresIn: 900,
};

const profile: MeResponse = {
  user: { id: session.user.id, email: session.user.email, phone: null, emailVerified: true, avatarUrl: null, username: null, firstName: null, onboardingStatus: 'survey_pending', notificationEnabled: true, level: 'beginner', timezone: 'Europe/Moscow', createdAt: session.user.createdAt, updatedAt: session.user.createdAt },
  survey: null,
  subscription: { provider: null, status: 'none', isActive: false, startsAt: null, expiresAt: null, amountMinor: null, currency: null },
};

const jsonResponse = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

describe('frontend session client', () => {
  beforeEach(() => {
    resetSessionForTests();
    vi.stubGlobal('fetch', vi.fn());
  });

  it('restores an access token from the HttpOnly refresh session on reload', async () => {
    vi.mocked(fetch).mockResolvedValueOnce(jsonResponse(session)).mockResolvedValueOnce(jsonResponse(profile));
    await expect(fetchMe()).resolves.toEqual(profile);
    expect(hasAccessToken()).toBe(true);
    expect(fetch).toHaveBeenNthCalledWith(1, expect.stringContaining('/api/v1/auth/refresh'), expect.objectContaining({ credentials: 'include' }));
    const protectedHeaders = vi.mocked(fetch).mock.calls[1]?.[1]?.headers as Headers;
    expect(protectedHeaders.get('Authorization')).toBe('Bearer access-token-new');
  });

  it('rotates and retries exactly once after a protected 401', async () => {
    setAccessToken('expired-token');
    vi.mocked(fetch)
      .mockResolvedValueOnce(jsonResponse({ error: { code: 'EXPIRED', message: 'expired' } }, 401))
      .mockResolvedValueOnce(jsonResponse(session))
      .mockResolvedValueOnce(jsonResponse(profile));
    await expect(fetchMe()).resolves.toEqual(profile);
    expect(fetch).toHaveBeenCalledTimes(3);
  });

  it('reports unauthenticated only when refresh is rejected', async () => {
    vi.mocked(fetch).mockResolvedValueOnce(jsonResponse({ error: { code: 'REFRESH_TOKEN_REQUIRED', message: 'missing' } }, 401));
    await expect(fetchMe()).rejects.toMatchObject({ status: 401, code: 'NO_SESSION' } satisfies Partial<ApiRequestError>);
  });

  it('keeps network failure distinct from authentication', async () => {
    vi.mocked(fetch).mockRejectedValueOnce(new TypeError('network down'));
    await expect(fetchMe()).rejects.toBeInstanceOf(ApiNetworkError);
  });

  it('keeps login access tokens in memory and includes refresh credentials', async () => {
    vi.mocked(fetch).mockResolvedValueOnce(jsonResponse(session));
    await loginSession({ identifier: 'user@example.com', password: 'StrongPassword123!' });
    expect(hasAccessToken()).toBe(true);
    expect(fetch).toHaveBeenCalledWith(expect.stringContaining('/api/v1/auth/login'), expect.objectContaining({ credentials: 'include' }));
    expect(window.localStorage.getItem('kinetra.accessToken')).toBeNull();
  });
});
''',
)

write(
    "apps/frontend/src/features/auth/LoginForm.test.tsx",
    r'''import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';

import { LoginForm } from './LoginForm';

describe('LoginForm', () => {
  it('requires identifier and password before submitting', async () => {
    const user = userEvent.setup();
    const onLogin = vi.fn().mockResolvedValue(undefined);
    render(<LoginForm onLogin={onLogin} />);
    const submit = screen.getByRole('button', { name: 'Войти' });
    expect(submit).toBeDisabled();
    await user.type(screen.getByLabelText('Email или телефон'), 'user@example.com');
    expect(submit).toBeDisabled();
    await user.type(screen.getByLabelText('Пароль'), 'StrongPassword123!');
    expect(submit).toBeEnabled();
    await user.click(submit);
    expect(onLogin).toHaveBeenCalledWith('user@example.com', 'StrongPassword123!');
  });
});
''',
)

write(
    "apps/frontend/src/features/survey/SurveyWizard.test.tsx",
    r'''import type { MeResponse, SurveyAnswer } from '@kinetra/shared';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { saveSurvey } from '../../lib/api';
import { SurveyWizard } from './SurveyWizard';

vi.mock('../../lib/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../lib/api')>();
  return { ...actual, saveSurvey: vi.fn() };
});

const survey: SurveyAnswer = {
  id: '00000000-0000-4000-8000-000000000010', version: 2, gender: 'female', age_range: '26-35', goal: 'strength', injuries: ['knees', 'other'], injuries_detail: 'Старая травма', experience: 'novice', is_current: true, created_at: '2026-08-20T00:00:00.000Z',
};

const savedProfile: MeResponse = {
  user: { id: '00000000-0000-4000-8000-000000000001', email: 'user@example.com', phone: null, emailVerified: true, avatarUrl: null, username: null, firstName: null, onboardingStatus: 'onboarding_pending', notificationEnabled: true, level: 'beginner', timezone: 'Europe/Moscow', createdAt: '2026-08-20T00:00:00.000Z', updatedAt: '2026-08-20T00:00:00.000Z' },
  survey,
  subscription: { provider: null, status: 'none', isActive: false, startsAt: null, expiresAt: null, amountMinor: null, currency: null },
};

const advanceToInjuries = async (): Promise<ReturnType<typeof userEvent.setup>> => {
  const user = userEvent.setup();
  await user.click(screen.getByRole('radio', { name: 'Женский' }));
  await user.click(screen.getByRole('button', { name: 'Далее' }));
  await user.click(screen.getByRole('radio', { name: '26–35' }));
  await user.click(screen.getByRole('button', { name: 'Далее' }));
  await user.click(screen.getByRole('radio', { name: /Сила/u }));
  await user.click(screen.getByRole('button', { name: 'Далее' }));
  return user;
};

describe('SurveyWizard', () => {
  beforeEach(() => vi.mocked(saveSurvey).mockResolvedValue(savedProfile));

  it('blocks each next step until the required answer is selected', async () => {
    const user = userEvent.setup();
    render(<SurveyWizard initialSurvey={null} onSaved={vi.fn()} />);
    expect(screen.getByText('Шаг 1 из 5')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Далее' })).toBeDisabled();
    await user.click(screen.getByRole('radio', { name: 'Женский' }));
    expect(screen.getByRole('button', { name: 'Далее' })).toBeEnabled();
    await user.click(screen.getByRole('button', { name: 'Далее' }));
    expect(screen.getByText('Шаг 2 из 5')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Далее' })).toBeDisabled();
  });

  it('keeps none exclusive and requires detail for other', async () => {
    render(<SurveyWizard initialSurvey={null} onSaved={vi.fn()} />);
    const user = await advanceToInjuries();
    const none = screen.getByRole('button', { name: 'Нет ограничений' });
    const knees = screen.getByRole('button', { name: 'Колени' });
    await user.click(none);
    expect(none).toHaveAttribute('aria-pressed', 'true');
    await user.click(knees);
    expect(none).toHaveAttribute('aria-pressed', 'false');
    await user.click(screen.getByRole('button', { name: 'Другое' }));
    expect(screen.getByRole('button', { name: 'Далее' })).toBeDisabled();
    await user.type(screen.getByLabelText('Опишите ограничение'), 'Щадящая нагрузка');
    expect(screen.getByRole('button', { name: 'Далее' })).toBeEnabled();
  });

  it('prefills edit mode from the latest server survey', () => {
    render(<SurveyWizard initialSurvey={survey} onSaved={vi.fn()} onCancel={vi.fn()} />);
    expect(screen.getByText('Редактирование анкеты')).toBeInTheDocument();
    expect(screen.getByRole('radio', { name: 'Женский' })).toHaveAttribute('aria-checked', 'true');
  });

  it('submits the complete survey and returns the updated profile', async () => {
    const onSaved = vi.fn();
    const user = userEvent.setup();
    render(<SurveyWizard initialSurvey={survey} onSaved={onSaved} onCancel={vi.fn()} />);
    for (let step = 0; step < 4; step += 1) await user.click(screen.getByRole('button', { name: 'Далее' }));
    await user.click(screen.getByRole('button', { name: 'Сохранить' }));
    expect(saveSurvey).toHaveBeenCalledWith({ gender: 'female', age_range: '26-35', goal: 'strength', injuries: ['knees', 'other'], injuries_detail: 'Старая травма', experience: 'novice' });
    expect(onSaved).toHaveBeenCalledWith(savedProfile);
  });
});
''',
)

write(
    "apps/frontend/src/App.test.tsx",
    r'''import type { MeResponse } from '@kinetra/shared';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { ApiNetworkError, ApiRequestError, fetchMe, loginSession } from './lib/api';
import { App } from './App';

vi.mock('./lib/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./lib/api')>();
  return { ...actual, fetchMe: vi.fn(), loginSession: vi.fn(), logoutSession: vi.fn(), saveSurvey: vi.fn() };
});

const profileFor = (status: MeResponse['user']['onboardingStatus']): MeResponse => ({
  user: { id: '00000000-0000-4000-8000-000000000001', email: 'user@example.com', phone: null, emailVerified: true, avatarUrl: null, username: null, firstName: 'Анна', onboardingStatus: status, notificationEnabled: true, level: 'beginner', timezone: 'Europe/Moscow', createdAt: '2026-08-20T00:00:00.000Z', updatedAt: '2026-08-20T00:00:00.000Z' },
  survey: null,
  subscription: { provider: null, status: 'none', isActive: false, startsAt: null, expiresAt: null, amountMinor: null, currency: null },
});

describe('App session and onboarding flow', () => {
  beforeEach(() => {
    vi.mocked(fetchMe).mockReset();
    vi.mocked(loginSession).mockReset();
  });

  it.each([
    ['survey_pending', 'Укажите ваш пол', '/survey'],
    ['onboarding_pending', 'Познакомимся с программой', '/onboarding'],
    ['base_lessons', 'Подготовьте основу', '/base-lessons'],
    ['active', 'Ваше движение начинается здесь', '/app'],
  ] as const)('restores %s and routes to the correct screen', async (status, title, path) => {
    vi.mocked(fetchMe).mockResolvedValue(profileFor(status));
    render(<App />);
    expect(await screen.findByText(title)).toBeInTheDocument();
    expect(window.location.pathname).toBe(path);
  });

  it('completes login handoff after refresh rejection', async () => {
    vi.mocked(fetchMe).mockRejectedValueOnce(new ApiRequestError('Нет сессии', 401, 'NO_SESSION')).mockResolvedValueOnce(profileFor('active'));
    vi.mocked(loginSession).mockResolvedValue({ user: { id: '00000000-0000-4000-8000-000000000001', email: 'user@example.com', phone: null, emailVerified: true, createdAt: '2026-08-20T00:00:00.000Z' }, accessToken: 'token', tokenType: 'Bearer', expiresIn: 900 });
    const user = userEvent.setup();
    render(<App />);
    expect(await screen.findByRole('heading', { name: 'Войдите в аккаунт' })).toBeInTheDocument();
    await user.type(screen.getByLabelText('Email или телефон'), 'user@example.com');
    await user.type(screen.getByLabelText('Пароль'), 'StrongPassword123!');
    await user.click(screen.getByRole('button', { name: 'Войти' }));
    expect(await screen.findByText('Ваше движение начинается здесь')).toBeInTheDocument();
  });

  it('shows a distinct offline state and retries', async () => {
    vi.mocked(fetchMe).mockRejectedValueOnce(new ApiNetworkError()).mockResolvedValueOnce(profileFor('base_lessons'));
    const user = userEvent.setup();
    render(<App />);
    expect(await screen.findByRole('heading', { name: 'Профиль сохранён на сервере' })).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: 'Войдите в аккаунт' })).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Повторить' }));
    await waitFor(() => expect(screen.getByText('Подготовьте основу')).toBeInTheDocument());
  });
});
''',
)

write(
    "scripts/verify-t04.mjs",
    r'''import { access, readFile, readdir } from 'node:fs/promises';
import { resolve } from 'node:path';

const root = process.cwd();
const failures = [];
const passes = [];
const read = (path) => readFile(resolve(root, path), 'utf8');
const expect = (condition, message) => (condition ? passes : failures).push(message);
const required = [
  'apps/backend/migrations/003_survey.sql',
  'apps/backend/src/auth/middleware.ts',
  'apps/backend/src/profile/router.ts',
  'apps/backend/src/profile/schema.ts',
  'apps/backend/test/profile.e2e.test.ts',
  'apps/backend/test/profile.postgres.test.ts',
  'apps/backend/test/survey-constraints.postgres.test.ts',
  'apps/frontend/src/features/auth/LoginForm.tsx',
  'apps/frontend/src/features/survey/SurveyWizard.tsx',
  'apps/frontend/src/features/survey/SurveyWizard.test.tsx',
  'apps/frontend/src/lib/api.test.ts',
  'apps/frontend/src/routing.ts',
  'apps/frontend/src/routing.test.ts',
  'apps/frontend/vitest.config.ts',
  'docs/T04_PROFILE_SURVEY.md',
];
for (const path of required) {
  try { await access(resolve(root, path)); passes.push(`file: ${path}`); }
  catch { failures.push(`missing file: ${path}`); }
}
const api = await read('apps/frontend/src/lib/api.ts');
expect(api.includes("credentials: 'include'"), 'refresh credentials included');
expect(api.includes('/api/v1/auth/refresh'), 'refresh endpoint used');
expect(api.includes('ApiNetworkError'), 'network error is distinct');
expect(!api.includes('localStorage') && !api.includes('sessionStorage'), 'access token is memory-only');
const app = await read('apps/frontend/src/App.tsx');
expect(app.includes('LoginForm'), 'login handoff exists');
expect(app.includes("sessionState === 'offline'"), 'offline state exists');
expect(app.includes('pathForStatus'), 'server-driven routing exists');
const migration = await read('apps/backend/migrations/003_survey.sql');
expect(migration.includes('kinetra_text_array_is_unique'), 'database rejects duplicate injuries');
expect(migration.includes('BETWEEN 1 AND 500'), 'database bounds injury detail');
const main = await read('apps/frontend/src/main.tsx');
expect(main.includes('@fontsource-variable/inter'), 'Inter is bundled');
const rootPackage = JSON.parse(await read('package.json'));
const frontendPackage = JSON.parse(await read('apps/frontend/package.json'));
expect(String(rootPackage.scripts?.test).includes('@kinetra/frontend'), 'root test includes frontend acceptance');
expect(Boolean(frontendPackage.scripts?.test), 'frontend test script exists');
for (const dependency of ['@fontsource-variable/inter', '@testing-library/react', '@testing-library/user-event', 'jsdom', 'vitest']) {
  expect(Boolean(frontendPackage.dependencies?.[dependency] || frontendPackage.devDependencies?.[dependency]), `dependency: ${dependency}`);
}
const workflows = await readdir(resolve(root, '.github/workflows'));
expect(workflows.length === 1 && workflows[0] === 'ci.yml', 'temporary workflows are absent');
if (failures.length > 0) {
  console.error(failures.map((item) => `FAIL: ${item}`).join('\n'));
  process.exitCode = 1;
} else {
  console.log(`KINETRA_T04_STRUCTURE=PASS (${passes.length} checks)`);
}
''',
)

root_package_path = ROOT / "package.json"
root_package = json.loads(root_package_path.read_text(encoding="utf-8"))
root_package["scripts"]["test"] = "npm run test -w @kinetra/backend && npm run test -w @kinetra/frontend"
root_package["scripts"]["verify:t04"] = "node scripts/verify-t04.mjs"
root_package["scripts"]["verify:structure"] = "node scripts/verify-project.mjs && node scripts/verify-t04.mjs"
root_package_path.write_text(json.dumps(root_package, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")

frontend_package_path = ROOT / "apps/frontend/package.json"
frontend_package = json.loads(frontend_package_path.read_text(encoding="utf-8"))
frontend_package["scripts"]["test"] = "vitest run --config vitest.config.ts"
frontend_package.setdefault("dependencies", {})["@fontsource-variable/inter"] = "^5.2.8"
frontend_package.setdefault("devDependencies", {}).update(
    {
        "@testing-library/jest-dom": "^6.9.1",
        "@testing-library/react": "^16.3.0",
        "@testing-library/user-event": "^14.6.1",
        "jsdom": "^27.2.0",
        "vitest": "^4.0.15",
    }
)
frontend_package_path.write_text(json.dumps(frontend_package, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")

ci_path = ROOT / ".github/workflows/ci.yml"
ci = ci_path.read_text(encoding="utf-8")
if "workflow_dispatch:" not in ci:
    ci = ci.replace("on:\n", "on:\n  workflow_dispatch:\n", 1)
ci = ci.replace("run: node scripts/verify-project.mjs", "run: npm run verify:structure")
ci_path.write_text(ci, encoding="utf-8")

write(
    "docs/T04_PROFILE_SURVEY.md",
    """# T04 — Profile, survey and resilient session\n\nThe protected profile API derives user identity exclusively from the verified JWT `sub` claim. Survey submissions are strictly validated with Zod and stored as immutable PostgreSQL versions with exactly one current row.\n\nThe browser keeps the short-lived access token only in memory. The rotating refresh token remains in an HttpOnly cookie. Startup performs refresh and profile restoration; a protected 401 performs one refresh-and-retry; network errors show an offline state rather than a false logout.\n\nServer status controls `/survey`, `/onboarding`, `/base-lessons` and `/app`; settings and prefilled survey editing use `/settings` and `/settings/survey`.\n\nAutomated acceptance covers backend identity and versioning, direct PostgreSQL constraint parity, frontend session rotation, login handoff, offline retry, required survey steps, injury rules and status routing.\n""",
)

print("T04 hardening files applied")
