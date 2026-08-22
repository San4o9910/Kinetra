import React, { type ReactNode } from 'react';

import { PAYMENT_PRICE_LABEL, paymentBenefits } from './model';

const CheckIcon = (): ReactNode =>
  React.createElement(
    'svg',
    { className: 'payment-benefit-icon', viewBox: '0 0 24 24', 'aria-hidden': true },
    React.createElement('circle', { cx: '12', cy: '12', r: '9' }),
    React.createElement('path', { d: 'm8 12.2 2.5 2.5L16.4 9' }),
  );

export interface PaymentViewProps {
  readonly busy: boolean;
  readonly error: string | null;
  readonly onBack: () => void;
  readonly onSubmit: () => void;
}

export const PaymentView = ({ busy, error, onBack, onSubmit }: PaymentViewProps): ReactNode => (
  <main className="payment-shell" data-testid="payment-screen">
    <div className="payment-layout">
      <header className="payment-topbar">
        <span className="payment-brand" aria-label="Kinetra">
          <span aria-hidden="true">K</span>
          KINETRA
        </span>
        <button className="payment-back" type="button" disabled={busy} onClick={onBack}>
          Назад
        </button>
      </header>

      <section className="payment-card" data-testid="payment-card" aria-labelledby="payment-title">
        <h1 id="payment-title">Kinetra Premium</h1>
        <p className="payment-price" data-testid="payment-price" aria-label={PAYMENT_PRICE_LABEL}>
          <strong>799 ₽</strong>
          <span>/ месяц</span>
        </p>

        <ul className="payment-benefits" data-testid="payment-benefits">
          {paymentBenefits.map((benefit) => (
            <li key={benefit}>
              <CheckIcon />
              <span>{benefit}</span>
            </li>
          ))}
        </ul>

        {error === null ? null : (
          <p className="payment-error" data-testid="payment-error" role="alert">
            {error}
          </p>
        )}

        <button
          className="payment-primary"
          data-testid="create-payment"
          type="button"
          disabled={busy}
          aria-busy={busy}
          onClick={onSubmit}
        >
          {busy ? 'Переходим к оплате…' : 'Оформить подписку'}
        </button>
        <p className="payment-renewal-copy">
          Подписка продлевается автоматически. Вы можете отменить в любой момент.
        </p>
      </section>
    </div>
  </main>
);
