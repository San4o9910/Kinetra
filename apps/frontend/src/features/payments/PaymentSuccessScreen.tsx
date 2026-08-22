import type { SubscriptionResponse } from '@kinetra/shared';
import React, { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';

import { ApiRequestError, getSubscription } from '../../lib/api';
import { pollForActiveSubscription } from './model';

type ConfirmationState =
  | { readonly kind: 'checking' }
  | { readonly kind: 'active'; readonly subscription: SubscriptionResponse }
  | { readonly kind: 'delayed' }
  | { readonly kind: 'error'; readonly message: string };

export interface PaymentSuccessScreenProps {
  readonly onActivated: (subscription: SubscriptionResponse) => void;
  readonly onContinue: () => void;
  readonly onSessionExpired: () => void;
}

export const PaymentSuccessScreen = ({
  onActivated,
  onContinue,
  onSessionExpired,
}: PaymentSuccessScreenProps): ReactNode => {
  const [state, setState] = useState<ConfirmationState>({ kind: 'checking' });
  const controllerRef = React.useRef<AbortController | null>(null);
  const requestVersionRef = useRef(0);

  const checkSubscription = useCallback((): void => {
    controllerRef.current?.abort();
    const controller = new AbortController();
    const version = ++requestVersionRef.current;
    controllerRef.current = controller;
    setState({ kind: 'checking' });

    void pollForActiveSubscription({
      signal: controller.signal,
      fetchSubscription: getSubscription,
    })
      .then((result) => {
        if (controller.signal.aborted || requestVersionRef.current !== version) {
          return;
        }

        if (result.kind === 'active') {
          setState({ kind: 'active', subscription: result.subscription });
          onActivated(result.subscription);
        } else {
          setState({ kind: 'delayed' });
        }
      })
      .catch((caught: unknown) => {
        if (controller.signal.aborted || requestVersionRef.current !== version) {
          return;
        }

        if (caught instanceof ApiRequestError && caught.kind === 'auth') {
          onSessionExpired();
          return;
        }

        setState({
          kind: 'error',
          message:
            caught instanceof ApiRequestError
              ? caught.message
              : 'Не удалось проверить подписку. Попробуйте ещё раз.',
        });
      });
  }, [onActivated, onSessionExpired]);

  useEffect(() => {
    checkSubscription();
    return () => {
      requestVersionRef.current += 1;
      controllerRef.current?.abort();
    };
  }, [checkSubscription]);

  const active = state.kind === 'active';

  return (
    <main className="payment-result-shell" data-testid="payment-success-screen">
      <section className="payment-result-card" aria-labelledby="payment-success-title">
        <span className="payment-success-icon" aria-hidden="true">
          🎉
        </span>
        <h1 id="payment-success-title">Оплата прошла успешно!</h1>
        <p data-testid="payment-success-status" role="status" aria-live="polite">
          {active
            ? 'Ваша подписка активирована'
            : state.kind === 'checking'
              ? 'Подтверждаем активацию подписки…'
              : state.kind === 'delayed'
                ? 'Платёж принят. Активация занимает немного больше времени.'
                : state.message}
        </p>

        {state.kind === 'delayed' || state.kind === 'error' ? (
          <button
            className="payment-secondary"
            data-testid="retry-subscription-check"
            type="button"
            onClick={checkSubscription}
          >
            Проверить снова
          </button>
        ) : null}

        <button
          className="payment-primary"
          data-testid="start-training"
          type="button"
          disabled={!active}
          onClick={onContinue}
        >
          Начать тренировки
        </button>
      </section>
    </main>
  );
};
