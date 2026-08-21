import React, { type ReactNode } from 'react';

export interface SubscriptionVerificationStateProps {
  readonly loading: boolean;
  readonly message?: string;
  readonly onRetry: () => void;
}

export const SubscriptionVerificationState = ({
  loading,
  message,
  onRetry,
}: SubscriptionVerificationStateProps): ReactNode => (
  <main className="subscription-verification-shell" data-testid="subscription-verification">
    <section className="subscription-verification-card" aria-live="polite">
      <h1>{loading ? 'Проверяем подписку' : 'Не удалось проверить подписку'}</h1>
      <p>
        {loading
          ? 'Это займёт всего несколько секунд.'
          : (message ?? 'Проверьте соединение и попробуйте ещё раз.')}
      </p>
      {loading ? (
        React.createElement('span', {
          className: 'subscription-verification-loader',
          role: 'status',
          'aria-label': 'Загрузка',
        })
      ) : (
        <button
          className="payment-primary"
          data-testid="retry-subscription"
          type="button"
          onClick={onRetry}
        >
          Повторить
        </button>
      )}
    </section>
  </main>
);
