import type { SubscriptionResponse } from '@kinetra/shared';
import React, { type ReactNode } from 'react';

import { SubscriptionPaywallDialog } from './SubscriptionPaywallDialog';

export interface SubscriptionLockedScreenProps {
  readonly subscription: SubscriptionResponse;
  readonly onOpenPayment: () => void;
}

export const SubscriptionLockedScreen = ({
  subscription,
  onOpenPayment,
}: SubscriptionLockedScreenProps): ReactNode => {
  const [paywallOpen, setPaywallOpen] = React.useState(true);

  return (
    <>
      <main
        className="subscription-verification-shell program-subscription-locked"
        data-testid="program-subscription-locked"
      >
        <section className="subscription-verification-card">
          <h1>Программа Kinetra Premium</h1>
          <p>Оформите подписку, чтобы открыть 84 тренировки на 12 недель.</p>
          <button
            className="payment-primary"
            data-testid="open-subscription-paywall"
            type="button"
            onClick={() => setPaywallOpen(true)}
          >
            Узнать подробнее
          </button>
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
