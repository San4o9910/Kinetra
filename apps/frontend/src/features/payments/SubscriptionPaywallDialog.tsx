import type { SubscriptionResponse } from '@kinetra/shared';
import React, { useEffect, type ReactNode } from 'react';

import { effectivePaywallStatus, isSubscriptionActive } from './model';

export interface SubscriptionPaywallDialogProps {
  readonly open: boolean;
  readonly subscription: SubscriptionResponse | null;
  readonly onClose: () => void;
  readonly onRenew: () => void;
}

export const SubscriptionPaywallDialog = ({
  open,
  subscription,
  onClose,
  onRenew,
}: SubscriptionPaywallDialogProps): ReactNode => {
  const dialogRef = React.useRef<HTMLDialogElement>(null);
  const status = effectivePaywallStatus(subscription);
  const expired =
    status === 'expired' ||
    status === 'cancelled' ||
    status === 'refunded' ||
    (status === 'active' && !isSubscriptionActive(subscription));

  useEffect(() => {
    const dialog = dialogRef.current;

    if (dialog === null) {
      return;
    }

    if (open && !dialog.open) {
      dialog.showModal();
    } else if (!open && dialog.open) {
      dialog.close();
    }
  }, [open]);

  return (
    <dialog
      ref={dialogRef}
      className="subscription-paywall"
      data-testid="subscription-paywall-dialog"
      aria-labelledby="subscription-paywall-title"
      aria-describedby="subscription-paywall-description"
      onCancel={(event) => {
        event.preventDefault();
        onClose();
      }}
      onClick={(event) => {
        if (event.target === event.currentTarget) {
          onClose();
        }
      }}
    >
      <div className="subscription-paywall-sheet">
        <span className="subscription-paywall-mark" aria-hidden="true">
          K+
        </span>
        <h2 id="subscription-paywall-title">
          {expired ? 'Подписка истекла' : 'Нужна подписка Kinetra Premium'}
        </h2>
        <p id="subscription-paywall-description">
          {expired
            ? 'Продлите подписку, чтобы снова открыть программу тренировок.'
            : 'Оформите подписку, чтобы открыть 12-недельную программу тренировок.'}
        </p>
        <div className="subscription-paywall-actions">
          <button
            className="payment-primary"
            data-testid="paywall-renew"
            type="button"
            onClick={onRenew}
          >
            {expired ? 'Продлить' : 'Оформить подписку'}
          </button>
          <button
            className="payment-secondary"
            data-testid="paywall-close"
            type="button"
            onClick={onClose}
          >
            Позже
          </button>
        </div>
      </div>
    </dialog>
  );
};
