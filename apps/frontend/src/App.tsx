import { useEffect, useState } from 'react';

import { useOnlineStatus } from './hooks/useOnlineStatus';
import { apiBaseUrl, fetchHealth } from './lib/api';

type ApiState =
  | { readonly status: 'checking'; readonly label: string }
  | { readonly status: 'online'; readonly label: string }
  | { readonly status: 'offline'; readonly label: string };

const initialApiState: ApiState = {
  status: 'checking',
  label: 'Проверяем backend…',
};

export const App = () => {
  const isOnline = useOnlineStatus();
  const [apiState, setApiState] = useState<ApiState>(initialApiState);

  useEffect(() => {
    const controller = new AbortController();

    void fetchHealth(controller.signal)
      .then((health) => {
        setApiState({
          status: 'online',
          label: `Backend работает · ${new Date(health.timestamp).toLocaleTimeString('ru-RU')}`,
        });
      })
      .catch((error: unknown) => {
        if (error instanceof DOMException && error.name === 'AbortError') {
          return;
        }

        setApiState({
          status: 'offline',
          label: 'Backend пока недоступен',
        });
      });

    return () => controller.abort();
  }, []);

  return (
    <main className="app-shell">
      <section className="hero" aria-labelledby="page-title">
        <div className="brand-row">
          <div className="brand-mark" aria-hidden="true">
            K
          </div>
          <div>
            <p className="eyebrow">KINETRA · T02 AUTH</p>
            <h1 id="page-title">Auth-модуль готов к подключению интерфейса</h1>
          </div>
        </div>

        <p className="hero-copy">
          Standalone PWA на React и TypeScript. Backend уже поддерживает регистрацию, вход,
          ротацию refresh-сессий, logout и безопасное восстановление пароля.
        </p>

        <div className="status-grid" aria-label="Состояние окружения">
          <article className="status-card">
            <span className={`status-dot ${isOnline ? 'is-online' : 'is-offline'}`} />
            <div>
              <strong>{isOnline ? 'Сеть доступна' : 'Нет подключения'}</strong>
              <span>PWA покажет локальный offline fallback</span>
            </div>
          </article>

          <article className="status-card">
            <span className={`status-dot is-${apiState.status}`} />
            <div>
              <strong>API</strong>
              <span>{apiState.label}</span>
            </div>
          </article>

          <article className="status-card">
            <span className="status-dot is-online" />
            <div>
              <strong>Установка</strong>
              <span>Manifest и service worker подключены</span>
            </div>
          </article>
        </div>

        <div className="actions">
          <a className="primary-action" href={`${apiBaseUrl}/health`} target="_blank" rel="noreferrer">
            Открыть health endpoint
          </a>
          <span className="tech-caption">React · Vite · Express · PostgreSQL · PWA</span>
        </div>
      </section>
    </main>
  );
};
