import React, { useLayoutEffect, useState, type FormEvent, type ReactNode } from 'react';

import { ApiRequestError, confirmPasswordReset, verifyEmail } from '../../lib/api';
import { ForgotPasswordScreen } from './ForgotPasswordScreen';
import { authLinkPaths, resetPasswordIssue, type AuthLink } from './authLinks';

interface AuthLinkGateProps {
  readonly link: AuthLink | null;
  readonly children: ReactNode;
  readonly onFinished?: () => void;
}

export const AuthLinkGate = ({ link, children, onFinished }: AuthLinkGateProps): ReactNode => {
  const [finished, setFinished] = useState(false);
  const [requestNew, setRequestNew] = useState(false);
  const [token, setToken] = useState(link?.token ?? null);
  const [password, setPassword] = useState('');
  const [confirmation, setConfirmation] = useState('');
  const [state, setState] = useState<'ready' | 'submitting' | 'success'>('ready');
  const [error, setError] = useState<string | null>(null);
  const busy = React.useRef(false);
  const isReset = link?.kind === 'reset';
  const issue =
    password.length === 0 && confirmation.length === 0
      ? null
      : resetPasswordIssue(password, confirmation);

  useLayoutEffect(() => {
    if (link === null || finished || typeof window === 'undefined') return;
    const handlePopState = (): void => {
      if (
        window.location.pathname === authLinkPaths.reset ||
        window.location.pathname === authLinkPaths.verify
      )
        return;
      setToken(null);
      setPassword('');
      setConfirmation('');
      setFinished(true);
      onFinished?.();
    };
    window.addEventListener('popstate', handlePopState);
    return () => window.removeEventListener('popstate', handlePopState);
  }, [finished, link, onFinished]);

  const continueToApp = (): void => {
    setToken(null);
    setPassword('');
    setConfirmation('');
    window.history.replaceState(null, '', '/login');
    setFinished(true);
    onFinished?.();
  };

  const submit = async (event?: FormEvent<HTMLFormElement>): Promise<void> => {
    event?.preventDefault();
    if (
      busy.current ||
      token === null ||
      (isReset && resetPasswordIssue(password, confirmation) !== null)
    )
      return;
    busy.current = true;
    setState('submitting');
    setError(null);
    try {
      if (isReset) await confirmPasswordReset(token, password);
      else await verifyEmail(token);
      setToken(null);
      setPassword('');
      setConfirmation('');
      setState('success');
    } catch (caught) {
      setState('ready');
      if (
        caught instanceof ApiRequestError &&
        ['INVALID_OR_EXPIRED_RESET_TOKEN', 'INVALID_OR_EXPIRED_VERIFICATION_TOKEN'].includes(
          caught.code,
        )
      ) {
        setToken(null);
        setPassword('');
        setConfirmation('');
      } else {
        setError(
          caught instanceof ApiRequestError && caught.code === 'WEAK_PASSWORD'
            ? 'Этот пароль не подходит. Используйте не меньше 10 символов. Если пароль очень длинный, сократите его.'
            : caught instanceof ApiRequestError && caught.status === 404 && !isReset
              ? 'Подтверждение email сейчас недоступно. Попробуйте войти в аккаунт.'
              : 'Не удалось завершить запрос. Проверьте подключение и попробуйте ещё раз.',
        );
      }
    } finally {
      busy.current = false;
    }
  };

  if (link === null || finished) return children;
  if (requestNew) return <ForgotPasswordScreen onBack={continueToApp} />;

  return (
    <main
      className="app-shell"
      data-testid={isReset ? 'password-reset-screen' : 'email-verification-screen'}
    >
      <section className="auth-card" aria-labelledby="auth-link-title">
        <div className="auth-copy">
          <p className="survey-kicker">KINETRA · ДОСТУП К АККАУНТУ</p>
          <h1 id="auth-link-title">{isReset ? 'Новый пароль' : 'Подтвердите email'}</h1>
        </div>
        {state === 'success' ? (
          <div
            className="auth-success"
            role="status"
            data-testid={isReset ? 'reset-success' : 'email-verification-success'}
          >
            {isReset
              ? 'Пароль изменён. Теперь войдите с новым паролем.'
              : 'Email подтверждён. Можно продолжить работу в Kinetra.'}
          </div>
        ) : token === null ? (
          <div role="alert" data-testid="auth-link-invalid">
            <p>Ссылка недействительна, истекла или уже использована.</p>
            {isReset ? (
              <button
                className="primary-button auth-submit"
                type="button"
                data-testid="auth-link-request-new"
                onClick={() => setRequestNew(true)}
              >
                Запросить новую ссылку
              </button>
            ) : (
              <p>Попробуйте войти в аккаунт. Если войти не получается, обратитесь в поддержку.</p>
            )}
          </div>
        ) : isReset ? (
          <form className="auth-form" onSubmit={(event) => void submit(event)}>
            <p id="reset-password-hint">
              Используйте не меньше 10 символов. После смены пароля потребуется войти заново.
            </p>
            <label htmlFor="reset-new-password">
              Новый пароль
              <input
                id="reset-new-password"
                data-testid="reset-new-password"
                type="password"
                autoComplete="new-password"
                required
                minLength={10}
                disabled={state === 'submitting'}
                value={password}
                onChange={(event) => setPassword(event.target.value)}
                aria-describedby="reset-password-hint reset-password-issue"
                aria-invalid={issue !== null}
              />
            </label>
            <label htmlFor="reset-confirm-password">
              Повторите пароль
              <input
                id="reset-confirm-password"
                data-testid="reset-confirm-password"
                type="password"
                autoComplete="new-password"
                required
                disabled={state === 'submitting'}
                value={confirmation}
                onChange={(event) => setConfirmation(event.target.value)}
                aria-describedby="reset-password-issue"
                aria-invalid={confirmation.length > 0 && password !== confirmation}
              />
            </label>
            <p
              id="reset-password-issue"
              data-testid="reset-password-issue"
              className="survey-error"
              aria-live="polite"
            >
              {issue}
            </p>
            <button
              className="primary-button auth-submit"
              data-testid="reset-confirm-submit"
              type="submit"
              disabled={
                state === 'submitting' ||
                password.length === 0 ||
                confirmation.length === 0 ||
                issue !== null
              }
            >
              {state === 'submitting' ? 'Сохраняем пароль…' : 'Сохранить новый пароль'}
            </button>
          </form>
        ) : (
          <div>
            <p>Нажмите кнопку, чтобы подтвердить адрес, указанный при регистрации.</p>
            <button
              className="primary-button auth-submit"
              data-testid="email-verification-submit"
              type="button"
              disabled={state === 'submitting'}
              onClick={() => void submit()}
            >
              {state === 'submitting' ? 'Подтверждаем…' : 'Подтвердить email'}
            </button>
          </div>
        )}
        {state === 'submitting' ? (
          <p role="status">{isReset ? 'Сохраняем новый пароль.' : 'Подтверждаем email.'}</p>
        ) : null}
        {error === null ? null : (
          <p className="survey-error" role="alert">
            {error}
          </p>
        )}
        <button
          className="auth-link-button"
          data-testid="auth-link-continue"
          type="button"
          disabled={state === 'submitting'}
          onClick={continueToApp}
        >
          {state === 'success' && !isReset ? 'Продолжить' : 'Вернуться ко входу'}
        </button>
      </section>
    </main>
  );
};
