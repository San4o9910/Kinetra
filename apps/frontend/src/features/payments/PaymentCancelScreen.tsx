import React, { type ReactNode } from 'react';

export interface PaymentCancelScreenProps {
  readonly onRetry: () => void;
  readonly onLater: () => void;
}

export const PaymentCancelScreen = ({ onRetry, onLater }: PaymentCancelScreenProps): ReactNode => (
  <main className="payment-result-shell" data-testid="payment-cancel-screen">
    <section className="payment-result-card is-cancel" aria-labelledby="payment-cancel-title">
      {React.createElement('span', { className: 'payment-cancel-icon', 'aria-hidden': true }, '×')}
      <h1 id="payment-cancel-title">Оплата не завершена</h1>
      <p>Вы можете попробовать ещё раз сейчас или вернуться к этому позже.</p>
      <button
        className="payment-primary"
        data-testid="retry-payment"
        type="button"
        onClick={onRetry}
      >
        Попробовать снова
      </button>
      <button
        className="payment-secondary"
        data-testid="payment-later"
        type="button"
        onClick={onLater}
      >
        Позже
      </button>
    </section>
  </main>
);
