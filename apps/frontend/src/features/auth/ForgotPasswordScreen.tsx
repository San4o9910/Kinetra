import React, { useState, type FormEvent, type ReactNode } from 'react';

import { ApiRequestError, requestPasswordReset } from '../../lib/api';

interface ForgotPasswordScreenProps {
  readonly onBack: () => void;
}

export const ForgotPasswordScreen = ({ onBack }: ForgotPasswordScreenProps): ReactNode => {
  const [email, setEmail] = useState('');
  const [state, setState] = useState<'ready' | 'sending' | 'sent'>('ready');
  const [error, setError] = useState<string | null>(null);
  const busy = React.useRef(false);

  const submit = async (event: FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault();
    if (busy.current || !event.currentTarget.reportValidity()) return;
    busy.current = true;
    setState('sending');
    setError(null);
    try {
      await requestPasswordReset(email.trim());
      setEmail('');
      setState('sent');
    } catch (caught) {
      setState('ready');
      setError(
        caught instanceof ApiRequestError && caught.status === 429
          ? 'Слишком много попыток. Подождите немного и попробуйте снова.'
          : 'Не удалось отправить запрос. Проверьте подключение и попробуйте ещё раз.',
      );
    } finally {
      busy.current = false;
    }
  };

  return (
    <main className="app-shell" data-testid="password-reset-request-screen">
      <section className="auth-card" aria-labelledby="reset-request-title">
        <div className="auth-copy">
          <p className="survey-kicker">KINETRA · ДОСТУП К АККАУНТУ</p>
          <h1 id="reset-request-title">Забыли пароль?</h1>
          <p>Укажите email, который вы использовали при регистрации.</p>
        </div>
        {state === 'sent' ? (
          <div className="auth-success" role="status" data-testid="reset-request-sent">
            Если аккаунт с таким email существует, на него придёт ссылка для смены пароля. Проверьте
            также папку «Спам».
          </div>
        ) : (
          <form className="auth-form" onSubmit={(event) => void submit(event)}>
            <label htmlFor="reset-email">
              Email
              <input
                id="reset-email"
                data-testid="reset-email"
                type="email"
                inputMode="email"
                autoComplete="email"
                required
                maxLength={254}
                disabled={state === 'sending'}
                value={email}
                onChange={(event) => setEmail(event.target.value)}
              />
            </label>
            {error === null ? null : (
              <p className="survey-error" role="alert">
                {error}
              </p>
            )}
            <button
              className="primary-button auth-submit"
              data-testid="reset-request-submit"
              type="submit"
              disabled={state === 'sending' || email.trim().length === 0}
            >
              {state === 'sending' ? 'Отправляем запрос…' : 'Получить ссылку'}
            </button>
            {state === 'sending' ? (
              <span className="visually-hidden" role="status">
                Отправляем запрос.
              </span>
            ) : null}
          </form>
        )}
        <button
          className="auth-link-button"
          data-testid="reset-request-back"
          type="button"
          disabled={state === 'sending'}
          onClick={onBack}
        >
          Вернуться ко входу
        </button>
      </section>
    </main>
  );
};
