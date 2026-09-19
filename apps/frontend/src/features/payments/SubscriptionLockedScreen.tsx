import type { SubscriptionResponse } from '@kinetra/shared';
import React, { type ReactNode } from 'react';

import { SubscriptionPaywallDialog } from './SubscriptionPaywallDialog';
import {
  PAYMENTS_UNAVAILABLE_DESCRIPTION,
  PAYMENTS_UNAVAILABLE_TITLE,
  arePaymentsEnabled,
} from './model';

export interface SubscriptionLockedScreenProps {
  readonly subscription: SubscriptionResponse;
  readonly onOpenPayment: () => void;
}

export const SubscriptionLockedScreen = ({
  subscription,
  onOpenPayment,
}: SubscriptionLockedScreenProps): ReactNode => {
  const [paywallOpen, setPaywallOpen] = React.useState(true);
  const paymentsEnabled = arePaymentsEnabled(subscription);

  return (
    <>
      <main
        className="subscription-verification-shell program-subscription-locked"
        data-testid="program-subscription-locked"
      >
        <section className="subscription-verification-card">
          <h1>{paymentsEnabled ? 'Программа Kinetra Premium' : PAYMENTS_UNAVAILABLE_TITLE}</h1>
          <p>
            {paymentsEnabled
              ? 'Оформите подписку, чтобы открыть 84 тренировки на 12 недель.'
              : PAYMENTS_UNAVAILABLE_DESCRIPTION}
          </p>
          {paymentsEnabled ? (
            <button
              className="payment-primary"
              data-testid="open-subscription-paywall"
              type="button"
              onClick={() => setPaywallOpen(true)}
            >
              Узнать подробнее
            </button>
          ) : null}
        </section>
      </main>
      <SubscriptionPaywallDialog
        open={paywallOpen}
        subscription={subscription}
        onClose={() => setPaywallOpen(false)}
        onRenew={onOpenPayment}
      />
    </>
  );
};
