import { useState, type FormEvent, type ReactNode } from 'react';
import type { MeResponse } from '@kinetra/shared';

import { ApiRequestError, fetchMe, login } from '../../lib/api';

interface LoginScreenProps {
  readonly onAuthenticated: (profile: MeResponse) => void;
}

export const LoginScreen = ({ onAuthenticated }: LoginScreenProps): ReactNode => {
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
      await login(identifier, password);
      const profile = await fetchMe();
      onAuthenticated(profile);
    } catch (caught) {
      setError(
        caught instanceof ApiRequestError
          ? caught.message
          : 'Не удалось войти. Проверьте данные и попробуйте ещё раз.',
      );
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <main className="app-shell" data-testid="login-screen">
      <section className="auth-card" aria-labelledby="login-title">
        <div className="survey-brand">
          <span className="survey-brand-mark" aria-hidden="true">
            K
          </span>
          <span>KINETRA</span>
        </div>

        <div className="auth-copy">
          <p className="survey-kicker">ЗАЩИЩЁННЫЙ ПРОФИЛЬ</p>
          <h1 id="login-title">Войдите в аккаунт</h1>
          <p>Мы восстановим вашу анкету и продолжим с сохранённого этапа программы.</p>
        </div>

        <form className="auth-form" onSubmit={(event) => void submit(event)} noValidate>
          <label>
            <span>Email или телефон</span>
            <input
              data-testid="login-identifier"
              type="text"
              inputMode="email"
              autoComplete="username"
              value={identifier}
              onChange={(event) => setIdentifier(event.target.value)}
              required
            />
          </label>

          <label>
            <span>Пароль</span>
            <input
              data-testid="login-password"
              type="password"
              autoComplete="current-password"
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

          <button
            className="primary-button auth-submit"
            data-testid="login-submit"
            type="submit"
            disabled={!canSubmit}
          >
            {isSubmitting ? 'Входим…' : 'Войти'}
          </button>
        </form>
      </section>
    </main>
  );
};
