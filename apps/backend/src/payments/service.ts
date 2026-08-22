import type {
  CreatePaymentResponse,
  SettingsSubscriptionStatus,
  SubscriptionResponse,
} from '@kinetra/shared';
import { randomUUID } from 'node:crypto';

import { HttpError } from '../auth/errors.js';
import type { Clock } from '../auth/service.js';
import type {
  PaymentSubscriptionSnapshot,
  PaymentsRepository,
  VerifiedPaymentEvent,
} from './repository.js';
import {
  createPaymentRequestSchema,
  subscriptionMetadataSchema,
  webhookNotificationSchema,
  yooKassaPaymentSchema,
  yooKassaRefundSchema,
  type YooKassaPayment,
} from './schema.js';
import {
  type YooKassaClient,
  YooKassaApiError,
  type YooKassaCreatePaymentInput,
} from './yookassa-client.js';

export const SUBSCRIPTION_AMOUNT_MINOR = 79_900;
export const SUBSCRIPTION_AMOUNT_VALUE = '799.00';
export const SUBSCRIPTION_CURRENCY = 'RUB';
const MILLISECONDS_PER_DAY = 24 * 60 * 60 * 1000;

const validationError = (code: string, message: string): HttpError =>
  new HttpError(400, code, message);

const normalizeUrl = (rawUrl: string): string => {
  const url = new URL(rawUrl);
  url.hash = '';
  return url.toString();
};

const asRecord = (value: object): Readonly<Record<string, unknown>> =>
  value as Readonly<Record<string, unknown>>;

const providerHttpError = (error: unknown): HttpError => {
  if (error instanceof YooKassaApiError) {
    return new HttpError(
      error.retryable ? 503 : 502,
      error.retryable ? 'PAYMENT_PROVIDER_UNAVAILABLE' : 'PAYMENT_PROVIDER_REJECTED',
      error.retryable
        ? 'The payment provider is temporarily unavailable.'
        : 'The payment provider rejected the request.',
    );
  }

  return new HttpError(503, 'PAYMENT_PROVIDER_UNAVAILABLE', 'The payment provider is unavailable.');
};

const effectiveStatus = (
  subscription: PaymentSubscriptionSnapshot,
  now: Date,
): Exclude<SettingsSubscriptionStatus, 'none'> => {
  if (subscription.status === 'refunded') {
    return 'cancelled';
  }

  if (
    subscription.status === 'active' &&
    subscription.expiresAt !== null &&
    subscription.expiresAt.getTime() <= now.getTime()
  ) {
    return 'expired';
  }

  if (
    subscription.status === 'active' &&
    subscription.startsAt !== null &&
    subscription.startsAt.getTime() > now.getTime()
  ) {
    return 'pending';
  }

  return subscription.status;
};

const subscriptionResponse = (
  subscription: PaymentSubscriptionSnapshot,
  now: Date,
): SubscriptionResponse => ({
  status: effectiveStatus(subscription, now),
  provider: subscription.provider,
  starts_at: subscription.startsAt?.toISOString() ?? null,
  expires_at: subscription.expiresAt?.toISOString() ?? null,
  amount: subscription.amountMinor === null ? null : subscription.amountMinor / 100,
  currency: subscription.currency,
  auto_renew: subscription.autoRenew,
  days_remaining:
    subscription.expiresAt === null
      ? null
      : Math.max(
          0,
          Math.ceil((subscription.expiresAt.getTime() - now.getTime()) / MILLISECONDS_PER_DAY),
        ),
});

const hasCanonicalSubscriptionAmount = (payment: YooKassaPayment): boolean =>
  payment.amount.value === SUBSCRIPTION_AMOUNT_VALUE &&
  payment.amount.currency === SUBSCRIPTION_CURRENCY;

const isFullyRefundedPayment = (payment: YooKassaPayment): boolean =>
  payment.refunded_amount?.value === payment.amount.value &&
  payment.refunded_amount.currency === payment.amount.currency;

const assertCanonicalSubscriptionPayment = (payment: YooKassaPayment): void => {
  if (!hasCanonicalSubscriptionAmount(payment)) {
    throw validationError(
      'INVALID_WEBHOOK_PAYMENT',
      'The YooKassa payment amount does not match the Kinetra subscription.',
    );
  }
};

export class PaymentsService {
  private readonly allowedReturnUrls: ReadonlySet<string>;

  public constructor(
    private readonly repository: PaymentsRepository,
    private readonly client: YooKassaClient,
    private readonly clock: Clock,
    allowedReturnUrls: readonly string[],
  ) {
    this.allowedReturnUrls = new Set(allowedReturnUrls.map(normalizeUrl));
  }

  public async createPayment(userId: string, body: unknown): Promise<CreatePaymentResponse> {
    const parsed = createPaymentRequestSchema.safeParse(body);

    if (!parsed.success) {
      throw validationError(
        'INVALID_PAYMENT_REQUEST',
        parsed.error.issues[0]?.message ?? 'The payment request is invalid.',
      );
    }

    const requestedReturnUrl = normalizeUrl(parsed.data.return_url);

    if (!this.allowedReturnUrls.has(requestedReturnUrl)) {
      throw validationError(
        'PAYMENT_RETURN_URL_NOT_ALLOWED',
        'The payment return URL is not allowed.',
      );
    }

    const claim = await this.repository.claimInitialPayment({
      userId,
      returnUrl: requestedReturnUrl,
      idempotencyKey: randomUUID(),
      amountMinor: SUBSCRIPTION_AMOUNT_MINOR,
      currency: SUBSCRIPTION_CURRENCY,
      now: this.clock.now(),
    });

    if (claim.kind === 'user_not_found') {
      throw new HttpError(404, 'PROFILE_NOT_FOUND', 'The authenticated user was not found.');
    }

    if (claim.kind === 'subscription_active') {
      throw new HttpError(
        409,
        'SUBSCRIPTION_ALREADY_ACTIVE',
        'The user already has an active subscription.',
      );
    }

    const { attempt } = claim;

    if (
      attempt.status === 'pending' &&
      attempt.providerPaymentId !== null &&
      attempt.confirmationUrl !== null
    ) {
      return {
        payment_id: attempt.providerPaymentId,
        confirmation_url: attempt.confirmationUrl,
        status: 'pending',
      };
    }

    const input: YooKassaCreatePaymentInput = {
      amount: { value: SUBSCRIPTION_AMOUNT_VALUE, currency: SUBSCRIPTION_CURRENCY },
      capture: true,
      confirmation: {
        type: 'redirect',
        return_url: attempt.returnUrl ?? requestedReturnUrl,
      },
      description: 'Подписка Kinetra — 1 месяц',
      save_payment_method: true,
      metadata: {
        user_id: userId,
        subscription_id: attempt.subscriptionId,
        attempt_id: attempt.id,
        type: 'subscription',
      },
    };
    let payment: YooKassaPayment;

    try {
      payment = await this.client.createPayment(input, attempt.idempotencyKey);
    } catch (error) {
      if (error instanceof YooKassaApiError && !error.retryable) {
        await this.repository.markAttemptFailed(attempt.id, {
          provider_error: error.statusCode ?? 'configuration',
        });
      }

      throw providerHttpError(error);
    }

    const responseMetadata = subscriptionMetadataSchema.safeParse(payment.metadata);
    const hasMatchingMetadata =
      responseMetadata.success &&
      responseMetadata.data.user_id === userId &&
      responseMetadata.data.subscription_id === attempt.subscriptionId &&
      responseMetadata.data.attempt_id === attempt.id &&
      responseMetadata.data.type === 'subscription';

    if (!hasCanonicalSubscriptionAmount(payment) || !hasMatchingMetadata) {
      throw new HttpError(
        502,
        'INVALID_PAYMENT_PROVIDER_RESPONSE',
        'The payment provider returned a payment that does not match this subscription attempt.',
      );
    }

    const rawConfirmationUrl = payment.confirmation?.confirmation_url ?? null;
    let confirmationUrl: string | null = null;

    if (payment.confirmation?.type === 'redirect' && rawConfirmationUrl !== null) {
      try {
        const url = new URL(rawConfirmationUrl);

        if (url.protocol === 'https:') {
          confirmationUrl = url.toString();
        }
      } catch {
        confirmationUrl = null;
      }
    }
    const attached = await this.repository.attachProviderPayment({
      attemptId: attempt.id,
      userId,
      providerPaymentId: payment.id,
      providerStatus:
        payment.status === 'canceled'
          ? 'canceled'
          : payment.status === 'succeeded'
            ? 'succeeded'
            : 'pending',
      confirmationUrl,
      rawPayload: asRecord(payment),
    });

    if (attached.kind === 'stale') {
      throw new HttpError(409, 'PAYMENT_ATTEMPT_STALE', 'The payment attempt is no longer valid.');
    }

    if (attached.kind === 'terminal') {
      if (attached.status === 'succeeded') {
        throw new HttpError(
          409,
          'SUBSCRIPTION_ALREADY_ACTIVE',
          'The payment has already succeeded and the subscription is active.',
        );
      }

      const terminalCode =
        attached.status === 'cancelled'
          ? 'PAYMENT_ALREADY_CANCELLED'
          : attached.status === 'refunded'
            ? 'PAYMENT_ALREADY_REFUNDED'
            : 'PAYMENT_ATTEMPT_FAILED';
      throw new HttpError(
        409,
        terminalCode,
        'The payment attempt reached a terminal state before checkout could be opened.',
      );
    }

    if (payment.status !== 'pending' || confirmationUrl === null) {
      throw new HttpError(
        502,
        'INVALID_PAYMENT_PROVIDER_RESPONSE',
        'The payment provider did not return a redirect confirmation.',
      );
    }

    return { payment_id: payment.id, confirmation_url: confirmationUrl, status: 'pending' };
  }

  public async handleWebhook(body: unknown): Promise<'applied' | 'duplicate' | 'ignored'> {
    const parsedNotification = webhookNotificationSchema.safeParse(body);

    if (!parsedNotification.success) {
      throw validationError(
        'INVALID_PAYMENT_WEBHOOK',
        parsedNotification.error.issues[0]?.message ?? 'The payment webhook is invalid.',
      );
    }

    const notification = parsedNotification.data;
    let payment: YooKassaPayment;
    let paymentId: string;
    let providerObjectId: string;
    let outcome: VerifiedPaymentEvent['outcome'];

    try {
      if (notification.event === 'refund.succeeded') {
        const inboundRefund = yooKassaRefundSchema.safeParse(notification.object);

        if (!inboundRefund.success || inboundRefund.data.status !== 'succeeded') {
          throw validationError('INVALID_PAYMENT_WEBHOOK', 'The refund webhook is invalid.');
        }

        const canonicalRefund = await this.client.getRefund(inboundRefund.data.id);

        if (
          canonicalRefund.id !== inboundRefund.data.id ||
          canonicalRefund.status !== 'succeeded' ||
          canonicalRefund.payment_id !== inboundRefund.data.payment_id
        ) {
          throw validationError('INVALID_PAYMENT_WEBHOOK', 'The refund could not be verified.');
        }

        payment = await this.client.getPayment(canonicalRefund.payment_id);
        paymentId = canonicalRefund.payment_id;
        providerObjectId = canonicalRefund.id;
        const fullyRefunded =
          (canonicalRefund.amount.value === payment.amount.value &&
            canonicalRefund.amount.currency === payment.amount.currency) ||
          isFullyRefundedPayment(payment);
        outcome = fullyRefunded ? 'refunded' : 'ignored';
      } else {
        const inboundPayment = yooKassaPaymentSchema.safeParse(notification.object);

        if (!inboundPayment.success) {
          throw validationError('INVALID_PAYMENT_WEBHOOK', 'The payment webhook is invalid.');
        }

        payment = await this.client.getPayment(inboundPayment.data.id);
        paymentId = payment.id;
        providerObjectId = payment.id;

        if (payment.id !== inboundPayment.data.id) {
          throw validationError('INVALID_PAYMENT_WEBHOOK', 'The payment could not be verified.');
        }

        if (notification.event === 'payment.succeeded') {
          if (payment.status !== 'succeeded' || payment.paid !== true) {
            throw validationError('INVALID_PAYMENT_WEBHOOK', 'The payment is not succeeded.');
          }

          outcome = isFullyRefundedPayment(payment) ? 'refunded' : 'succeeded';
        } else {
          if (payment.status !== 'canceled') {
            throw validationError('INVALID_PAYMENT_WEBHOOK', 'The payment is not canceled.');
          }

          outcome = 'cancelled';
        }
      }
    } catch (error) {
      if (error instanceof HttpError) {
        throw error;
      }

      throw providerHttpError(error);
    }

    assertCanonicalSubscriptionPayment(payment);
    const metadata = subscriptionMetadataSchema.safeParse(payment.metadata);

    if (!metadata.success) {
      throw validationError(
        'INVALID_WEBHOOK_METADATA',
        'The YooKassa payment does not contain valid Kinetra subscription metadata.',
      );
    }

    const paymentMethodSaved = payment.payment_method?.saved === true;

    return this.repository.applyVerifiedEvent(
      {
        eventId: `yukassa:${notification.event}:${providerObjectId}`,
        eventType: notification.event,
        providerObjectId,
        paymentId,
        userId: metadata.data.user_id,
        subscriptionId: metadata.data.subscription_id,
        attemptId: metadata.data.attempt_id,
        outcome,
        paymentMethodId: paymentMethodSaved ? (payment.payment_method?.id ?? null) : null,
        paymentMethodSaved,
        rawPayload: asRecord(notification),
      },
      this.clock.now(),
    );
  }

  public async cancelSubscription(userId: string): Promise<SubscriptionResponse> {
    const now = this.clock.now();
    const lookup = await this.repository.cancelAutoRenew(userId, now);

    if (!lookup.userExists) {
      throw new HttpError(404, 'PROFILE_NOT_FOUND', 'The authenticated user was not found.');
    }

    if (lookup.subscription === null) {
      throw new HttpError(404, 'SUBSCRIPTION_NOT_FOUND', 'The subscription was not found.');
    }

    return subscriptionResponse(lookup.subscription, now);
  }
}
