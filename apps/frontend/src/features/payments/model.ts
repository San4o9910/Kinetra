import type {
  CreatePaymentResponse,
  SubscriptionResponse,
  SubscriptionStatus,
} from '@kinetra/shared';

export const PAYMENT_PRICE_MINOR = 79_900;
export const PAYMENT_PRICE_LABEL = '799 ₽ / месяц';
export const PAYMENT_POLL_INTERVAL_MS = 2_000;
export const PAYMENT_POLL_TIMEOUT_MS = 30_000;

export const paymentBenefits = [
  '84 видео-тренировки (12 недель)',
  '7 направлений: дыхание, сила, растяжка и другие',
  'Отслеживание прогресса и достижения',
  'Еженедельная самооценка состояния',
  'Связь с тренером',
] as const;

const timestamp = (value: string | null): number | null => {
  if (value === null) {
    return null;
  }

  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? null : parsed;
};

export const isSubscriptionActive = (
  subscription: SubscriptionResponse | null,
  now = Date.now(),
): boolean => {
  if (subscription?.status !== 'active') {
    return false;
  }

  const startsAt = timestamp(subscription.starts_at);
  const expiresAt = timestamp(subscription.expires_at);

  return startsAt !== null && startsAt <= now && expiresAt !== null && expiresAt > now;
};

export const effectivePaywallStatus = (
  subscription: SubscriptionResponse | null,
): SubscriptionStatus | 'none' => {
  if (subscription === null || subscription.status === 'none') {
    return 'none';
  }

  return subscription.status;
};

export type CreatePaymentOperation = (returnUrl: string) => Promise<CreatePaymentResponse>;
export type PaymentRedirect = (confirmationUrl: string) => void;

export const beginPayment = async (
  returnUrl: string,
  create: CreatePaymentOperation,
  redirect: PaymentRedirect,
): Promise<CreatePaymentResponse> => {
  const response = await create(returnUrl);
  redirect(response.confirmation_url);
  return response;
};

export type SubscriptionPollResult =
  | { readonly kind: 'active'; readonly subscription: SubscriptionResponse }
  | { readonly kind: 'timeout'; readonly subscription: SubscriptionResponse | null };

export type PaymentDeadlineScheduler = (milliseconds: number, onDeadline: () => void) => () => void;

interface PollSubscriptionOptions {
  readonly fetchSubscription: (signal: AbortSignal) => Promise<SubscriptionResponse>;
  readonly signal: AbortSignal;
  readonly intervalMs?: number;
  readonly timeoutMs?: number;
  readonly now?: () => number;
  readonly wait?: (milliseconds: number, signal: AbortSignal) => Promise<void>;
  readonly scheduleDeadline?: PaymentDeadlineScheduler;
}

const abortError = (): DOMException => new DOMException('The operation was aborted.', 'AbortError');

const waitFor = (milliseconds: number, signal: AbortSignal): Promise<void> =>
  new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(abortError());
      return;
    }

    const timer = setTimeout(() => {
      signal.removeEventListener('abort', handleAbort);
      resolve();
    }, milliseconds);
    const handleAbort = (): void => {
      clearTimeout(timer);
      reject(abortError());
    };

    signal.addEventListener('abort', handleAbort, { once: true });
  });

const schedulePaymentDeadline: PaymentDeadlineScheduler = (milliseconds, onDeadline) => {
  const timer = setTimeout(onDeadline, Math.max(0, milliseconds));
  return () => clearTimeout(timer);
};

type DeadlineResult<Value> =
  { readonly kind: 'value'; readonly value: Value } | { readonly kind: 'deadline' };

export const pollForActiveSubscription = async ({
  fetchSubscription,
  signal,
  intervalMs = PAYMENT_POLL_INTERVAL_MS,
  timeoutMs = PAYMENT_POLL_TIMEOUT_MS,
  now = Date.now,
  wait = waitFor,
  scheduleDeadline = schedulePaymentDeadline,
}: PollSubscriptionOptions): Promise<SubscriptionPollResult> => {
  if (signal.aborted) {
    throw abortError();
  }

  const startedAt = now();
  const operationController = new AbortController();
  let subscription: SubscriptionResponse | null = null;
  let deadlineExpired = false;
  let resolveDeadline: () => void = () => undefined;
  let rejectForCallerAbort: (error: DOMException) => void = () => undefined;

  const deadlinePromise = new Promise<void>((resolve) => {
    resolveDeadline = resolve;
  });
  const callerAbortPromise = new Promise<never>((_resolve, reject) => {
    rejectForCallerAbort = reject;
  });
  const handleCallerAbort = (): void => {
    operationController.abort();
    rejectForCallerAbort(abortError());
  };

  signal.addEventListener('abort', handleCallerAbort, { once: true });
  const cancelDeadline = scheduleDeadline(timeoutMs, () => {
    deadlineExpired = true;
    resolveDeadline();
    operationController.abort();
  });

  const withinDeadline = async <Value>(
    operation: Promise<Value>,
  ): Promise<DeadlineResult<Value>> => {
    try {
      return await Promise.race([
        operation.then((value) => ({ kind: 'value' as const, value })),
        deadlinePromise.then(() => ({ kind: 'deadline' as const })),
        callerAbortPromise,
      ]);
    } catch (error) {
      if (deadlineExpired) {
        return { kind: 'deadline' };
      }

      throw error;
    }
  };

  try {
    const initialSubscription = await withinDeadline(fetchSubscription(operationController.signal));

    if (initialSubscription.kind === 'deadline') {
      return { kind: 'timeout', subscription };
    }

    subscription = initialSubscription.value;

    while (!isSubscriptionActive(subscription, now())) {
      if (signal.aborted) {
        throw abortError();
      }

      const remaining = timeoutMs - (now() - startedAt);

      if (remaining <= 0) {
        return { kind: 'timeout', subscription };
      }

      const intervalFinished = await withinDeadline(
        wait(Math.min(intervalMs, remaining), operationController.signal),
      );

      if (intervalFinished.kind === 'deadline') {
        return { kind: 'timeout', subscription };
      }

      const nextSubscription = await withinDeadline(fetchSubscription(operationController.signal));

      if (nextSubscription.kind === 'deadline') {
        return { kind: 'timeout', subscription };
      }

      subscription = nextSubscription.value;
    }

    return { kind: 'active', subscription };
  } finally {
    cancelDeadline();
    signal.removeEventListener('abort', handleCallerAbort);
    operationController.abort();
  }
};
