import { useState, type FormEvent, type ReactNode } from 'react';
import type { MeResponse, RequestedRole } from '@kinetra/shared';

import { ApiRequestError, fetchMe, register } from '../../lib/api';

const registrationRoles: readonly {
  readonly id: RequestedRole;
  readonly label: 'Тренер' | 'Тренирующийся';
  readonly description: string;
}[] = [
  {
    id: 'trainer',
    label: 'Тренер',
    description: 'Хочу подтвердить квалификацию и работать с подопечными',
  },
  {
    id: 'trainee',
    label: 'Тренирующийся',
    description: 'Хочу тренироваться и отслеживать свой прогресс',
  },
];

type RegistrationCompletion =
  | { readonly kind: 'email_verification' }
  | { readonly kind: 'profile_retry'; readonly message: string };

interface RegisterScreenProps {
  readonly onAuthenticated: (profile: MeResponse) => void;
  readonly onBack: () => void;
}

const profileLoadMessage = (error: unknown): string =>
  error instanceof ApiRequestError
    ? error.message
    : 'Не удалось загрузить профиль. Проверьте подключение и попробуйте ещё раз.';

export const RegisterScreen = ({ onAuthenticated, onBack }: RegisterScreenProps): ReactNode => {
  const [requestedRole, setRequestedRole] = useState<RequestedRole | null>(null);
  const [email, setEmail] = useState('');
  const [phone, setPhone] = useState('');
  const [password, setPassword] = useState('');
  const [passwordConfirmation, setPasswordConfirmation] = useState('');
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [completion, setCompletion] = useState<RegistrationCompletion | null>(null);
  const canSubmit =
    requestedRole !== null &&
    email.trim().length > 0 &&
    password.length > 0 &&
    passwordConfirmation.length > 0 &&
    !isSubmitting;

  const loadCreatedProfile = async (): Promise<void> => {
    setIsSubmitting(true);
    setError(null);

    try {
      const profile = await fetchMe();
      onAuthenticated(profile);
    } catch (caught) {
      setCompletion({ kind: 'profile_retry', message: profileLoadMessage(caught) });
    } finally {
      setIsSubmitting(false);
    }
  };

  const submit = async (event: FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault();

    if (!canSubmit || requestedRole === null) {
      return;
    }

    if (password !== passwordConfirmation) {
      setError('Пароли не совпадают.');
      return;
    }

    setIsSubmitting(true);
    setError(null);

    try {
      const result = await register({
        email: email.trim(),
        ...(phone.trim().length === 0 ? {} : { phone: phone.trim() }),
        password,
        requested_role: requestedRole,
      });

      if ('emailVerificationRequired' in result) {
        setCompletion({ kind: 'email_verification' });
        return;
      }

      try {
        const profile = await fetchMe();
        onAuthenticated(profile);
      } catch (caught) {
        setCompletion({ kind: 'profile_retry', message: profileLoadMessage(caught) });
      }
    } catch (caught) {
      setError(
        caught instanceof ApiRequestError
          ? caught.message
          : 'Не удалось создать аккаунт. Попробуйте ещё раз.',
      );
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <main className="app-shell" data-testid="register-screen">
      <section className="auth-card" aria-labelledby="register-title">
        <div className="survey-brand">
          <span className="survey-brand-mark" aria-hidden="true">
            K
          </span>
          <span>KINETRA</span>
        </div>

        <div className="auth-copy">
          <p className="survey-kicker">НОВЫЙ ПРОФИЛЬ</p>
          <h1 id="register-title">Создайте аккаунт</h1>
          <p>Выберите роль. Права тренера появятся только после ручной проверки заявки.</p>
        </div>

        {completion === null ? (
          <form className="auth-form" onSubmit={(event) => void submit(event)} noValidate>
            <fieldset className="auth-role-picker">
              <legend>Кем вы хотите пользоваться Kinetra?</legend>
              <div className="auth-role-options">
                {registrationRoles.map((role) => (
                  <label
                    className={`auth-role-option ${requestedRole === role.id ? 'is-selected' : ''}`}
                    key={role.id}
                  >
                    <input
                      data-testid={`register-role-${role.id}`}
                      type="radio"
                      name="requested-role"
                      value={role.id}
                      checked={requestedRole === role.id}
                      onChange={() => setRequestedRole(role.id)}
                      required
                    />
                    <span className="auth-role-option-copy">
                      <strong>{role.label}</strong>
                      <small>{role.description}</small>
                    </span>
                  </label>
                ))}
              </div>
            </fieldset>

            <label>
              <span>Email</span>
              <input
                data-testid="register-email"
                type="email"
                autoComplete="email"
                value={email}
                onChange={(event) => setEmail(event.target.value)}
                required
              />
            </label>

            <label>
              <span>
                Телефон <em>необязательно</em>
              </span>
              <input
                data-testid="register-phone"
                type="tel"
                autoComplete="tel"
                value={phone}
                onChange={(event) => setPhone(event.target.value)}
              />
            </label>

            <label>
              <span>Пароль</span>
              <input
                data-testid="register-password"
                type="password"
                autoComplete="new-password"
                value={password}
                onChange={(event) => setPassword(event.target.value)}
                required
              />
            </label>

            <label>
              <span>Повторите пароль</span>
              <input
                data-testid="register-password-confirmation"
                type="password"
                autoComplete="new-password"
                value={passwordConfirmation}
                onChange={(event) => setPasswordConfirmation(event.target.value)}
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
              data-testid="register-submit"
              type="submit"
              disabled={!canSubmit}
            >
              {isSubmitting ? 'Создаём аккаунт…' : 'Создать аккаунт'}
            </button>
          </form>
        ) : completion.kind === 'email_verification' ? (
          <div className="auth-success" role="status">
            <strong>Аккаунт создан.</strong>
            <span>Проверьте почту и подтвердите email, затем войдите в аккаунт.</span>
          </div>
        ) : (
          <div className="auth-success" role="status">
            <strong>Аккаунт создан.</strong>
            <span>{completion.message}</span>
            <button
              className="primary-button auth-submit"
              data-testid="register-profile-retry"
              type="button"
              disabled={isSubmitting}
              onClick={() => void loadCreatedProfile()}
            >
              {isSubmitting ? 'Загружаем профиль…' : 'Повторить загрузку профиля'}
            </button>
          </div>
        )}

        <button className="auth-link-button" type="button" onClick={onBack} disabled={isSubmitting}>
          Вернуться ко входу
        </button>
      </section>
    </main>
  );
};
