import type { SubscriptionResponse } from '@kinetra/shared';
import React, { type ReactNode } from 'react';

import {
  PAYMENTS_UNAVAILABLE_DESCRIPTION,
  PAYMENTS_UNAVAILABLE_TITLE,
  arePaymentsEnabled,
} from './model';
import { SubscriptionVerificationState } from './SubscriptionVerificationState';

export interface PaymentAvailabilityGateProps {
  readonly subscription: SubscriptionResponse | null;
  readonly loading: boolean;
  readonly message?: string;
  readonly onRetry: () => void;
  readonly onBack: () => void;
  readonly children: ReactNode;
}

export const PaymentAvailabilityGate = ({
  subscription,
  loading,
  message,
  onRetry,
  onBack,
  children,
}: PaymentAvailabilityGateProps): ReactNode => {
  if (loading || subscription === null) {
    return (
      <SubscriptionVerificationState
        loading={loading}
        {...(message === undefined ? {} : { message })}
        onRetry={onRetry}
      />
    );
  }

  if (!arePaymentsEnabled(subscription)) {
    return (
      <main className="payment-result-shell" data-testid="payments-unavailable-screen">
        <section className="payment-result-card" aria-labelledby="payments-unavailable-title">
          <h1 id="payments-unavailable-title">{PAYMENTS_UNAVAILABLE_TITLE}</h1>
          <p>{PAYMENTS_UNAVAILABLE_DESCRIPTION}</p>
          <button
            className="payment-primary"
            data-testid="payments-unavailable-back"
            type="button"
            onClick={onBack}
          >
            Вернуться в приложение
          </button>
        </section>
      </main>
    );
  }

  return <React.Fragment>{children}</React.Fragment>;
};
