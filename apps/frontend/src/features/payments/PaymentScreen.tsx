import { useRef, useState, type ReactNode } from 'react';

import { ApiRequestError, createPayment } from '../../lib/api';
import { appRoutes } from '../../routing';
import { beginPayment } from './model';
import { PaymentView } from './PaymentView';

export interface PaymentScreenProps {
  readonly onBack: () => void;
  readonly onSessionExpired: () => void;
}

export const PaymentScreen = ({ onBack, onSessionExpired }: PaymentScreenProps): ReactNode => {
  const submissionInFlight = useRef(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async (): Promise<void> => {
    if (submissionInFlight.current) {
      return;
    }

    submissionInFlight.current = true;
    setBusy(true);
    setError(null);

    try {
      const returnUrl = new URL(appRoutes.paymentSuccess, window.location.origin).toString();
      await beginPayment(returnUrl, createPayment, (confirmationUrl) => {
        window.location.assign(confirmationUrl);
      });
    } catch (caught) {
      submissionInFlight.current = false;
      setBusy(false);

      if (caught instanceof ApiRequestError && caught.kind === 'auth') {
        onSessionExpired();
        return;
      }

      setError(
        caught instanceof ApiRequestError
          ? caught.message
          : 'Не удалось перейти к оплате. Проверьте соединение и попробуйте ещё раз.',
      );
    }
  };

  return <PaymentView busy={busy} error={error} onBack={onBack} onSubmit={() => void submit()} />;
};
