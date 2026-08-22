import { randomUUID } from 'node:crypto';

import type {
  ApplyPaymentEventResult,
  AttachProviderPaymentInput,
  AttachProviderPaymentResult,
  ClaimInitialPaymentInput,
  InitialPaymentClaim,
  PaymentAttemptSnapshot,
  PaymentSubscriptionSnapshot,
  PaymentsRepository,
  RenewalClaim,
  RenewalClaimExecutionResult,
  RenewalProviderPayment,
  SubscriptionLookup,
  VerifiedPaymentEvent,
} from '../../src/payments/repository.js';

const PERIOD_MS = 30 * 24 * 60 * 60 * 1000;

const cloneAttempt = (attempt: PaymentAttemptSnapshot): PaymentAttemptSnapshot => ({
  ...attempt,
  renewsExpiresAt:
    attempt.renewsExpiresAt === null ? null : new Date(attempt.renewsExpiresAt.getTime()),
});

const cloneSubscription = (
  subscription: PaymentSubscriptionSnapshot,
): PaymentSubscriptionSnapshot => ({
  ...subscription,
  startsAt: subscription.startsAt === null ? null : new Date(subscription.startsAt.getTime()),
  expiresAt: subscription.expiresAt === null ? null : new Date(subscription.expiresAt.getTime()),
});

export class InMemoryPaymentsRepository implements PaymentsRepository {
  private subscription: PaymentSubscriptionSnapshot | null = null;
  private readonly attempts = new Map<string, PaymentAttemptSnapshot>();
  private readonly events = new Set<string>();
  private subscriptionLock: Promise<void> = Promise.resolve();
  private afterRenewalClaim: (() => Promise<void>) | null = null;

  public constructor(private readonly userId: string) {}

  public async claimInitialPayment(input: ClaimInitialPaymentInput): Promise<InitialPaymentClaim> {
    if (input.userId !== this.userId) {
      return { kind: 'user_not_found' };
    }

    if (
      this.subscription?.status === 'active' &&
      this.subscription.startsAt !== null &&
      this.subscription.startsAt <= input.now &&
      this.subscription.expiresAt !== null &&
      this.subscription.expiresAt > input.now
    ) {
      return { kind: 'subscription_active' };
    }

    const open = [...this.attempts.values()].find(
      (attempt) =>
        attempt.userId === input.userId &&
        attempt.kind === 'initial' &&
        ['creating', 'pending'].includes(attempt.status),
    );

    if (open !== undefined) {
      return { kind: 'claimed', attempt: cloneAttempt(open) };
    }

    const subscriptionId = randomUUID();
    this.subscription = {
      id: subscriptionId,
      userId: input.userId,
      provider: 'yukassa',
      status: 'pending',
      startsAt: null,
      expiresAt: null,
      amountMinor: input.amountMinor,
      currency: input.currency,
      autoRenew: true,
      paymentMethodId: null,
    };
    const attempt: PaymentAttemptSnapshot = {
      id: randomUUID(),
      subscriptionId,
      userId: input.userId,
      providerPaymentId: null,
      kind: 'initial',
      status: 'creating',
      idempotencyKey: input.idempotencyKey,
      renewsExpiresAt: null,
      returnUrl: input.returnUrl,
      confirmationUrl: null,
    };
    this.attempts.set(attempt.id, attempt);
    return { kind: 'claimed', attempt: cloneAttempt(attempt) };
  }

  public async attachProviderPayment(
    input: AttachProviderPaymentInput,
  ): Promise<AttachProviderPaymentResult> {
    const attempt = this.attempts.get(input.attemptId);

    if (attempt === undefined || attempt.userId !== input.userId) {
      return { kind: 'stale' };
    }

    if (
      attempt.providerPaymentId !== null &&
      attempt.providerPaymentId !== input.providerPaymentId
    ) {
      return { kind: 'stale' };
    }

    if (
      attempt.status === 'succeeded' ||
      attempt.status === 'cancelled' ||
      attempt.status === 'refunded' ||
      attempt.status === 'failed'
    ) {
      return { kind: 'terminal', status: attempt.status };
    }

    this.attempts.set(attempt.id, {
      ...attempt,
      providerPaymentId: input.providerPaymentId,
      status: input.providerStatus === 'canceled' ? 'cancelled' : input.providerStatus,
      confirmationUrl: input.providerStatus === 'pending' ? input.confirmationUrl : null,
    });

    if (input.providerStatus === 'canceled' && this.subscription !== null) {
      this.subscription = {
        ...this.subscription,
        status: attempt.kind === 'initial' ? 'cancelled' : this.subscription.status,
        autoRenew: false,
      };
    }

    return { kind: 'attached' };
  }

  public async markAttemptFailed(
    attemptId: string,
    _rawPayload: Readonly<Record<string, unknown>>,
  ): Promise<void> {
    const attempt = this.attempts.get(attemptId);

    if (attempt === undefined || attempt.status !== 'creating') {
      return;
    }

    this.attempts.set(attempt.id, { ...attempt, status: 'failed' });

    if (this.subscription !== null) {
      this.subscription = {
        ...this.subscription,
        status: attempt.kind === 'initial' ? 'cancelled' : this.subscription.status,
        autoRenew: false,
      };
    }
  }

  public async applyVerifiedEvent(
    event: VerifiedPaymentEvent,
    now: Date,
  ): Promise<ApplyPaymentEventResult> {
    if (this.events.has(event.eventId)) {
      return 'duplicate';
    }

    this.events.add(event.eventId);
    const attempt = this.attempts.get(event.attemptId);

    if (
      attempt === undefined ||
      attempt.subscriptionId !== event.subscriptionId ||
      attempt.userId !== event.userId ||
      (attempt.providerPaymentId !== null && attempt.providerPaymentId !== event.paymentId) ||
      this.subscription?.id !== event.subscriptionId
    ) {
      return 'ignored';
    }

    if (event.outcome === 'ignored') {
      return 'ignored';
    }

    this.attempts.set(attempt.id, {
      ...attempt,
      providerPaymentId: event.paymentId,
      status:
        event.outcome === 'cancelled'
          ? 'cancelled'
          : event.outcome === 'refunded'
            ? 'refunded'
            : 'succeeded',
    });
    const subscription = this.subscription;

    if (event.outcome === 'succeeded') {
      const base =
        attempt.kind === 'renewal' && subscription.expiresAt !== null
          ? new Date(Math.max(subscription.expiresAt.getTime(), now.getTime()))
          : now;
      this.subscription = {
        ...subscription,
        status: 'active',
        startsAt: subscription.startsAt ?? new Date(now.getTime()),
        expiresAt: new Date(base.getTime() + PERIOD_MS),
        paymentMethodId:
          attempt.kind === 'initial'
            ? event.paymentMethodSaved
              ? event.paymentMethodId
              : null
            : event.paymentMethodSaved
              ? (event.paymentMethodId ?? subscription.paymentMethodId)
              : subscription.paymentMethodId,
        autoRenew:
          attempt.kind === 'initial'
            ? subscription.autoRenew && event.paymentMethodSaved && event.paymentMethodId !== null
            : subscription.autoRenew,
      };
    } else if (event.outcome === 'cancelled') {
      this.subscription = {
        ...subscription,
        status:
          attempt.kind === 'initial'
            ? 'cancelled'
            : subscription.expiresAt !== null && subscription.expiresAt <= now
              ? 'expired'
              : subscription.status,
        autoRenew: false,
      };
    } else {
      this.subscription = { ...subscription, status: 'refunded', autoRenew: false };
    }

    return 'applied';
  }

  public async cancelAutoRenew(userId: string, _now: Date): Promise<SubscriptionLookup> {
    return this.withSubscriptionLock(async () => {
      if (userId !== this.userId) {
        return { userExists: false, subscription: null };
      }

      if (this.subscription === null) {
        return { userExists: true, subscription: null };
      }

      this.subscription = { ...this.subscription, autoRenew: false };
      return { userExists: true, subscription: cloneSubscription(this.subscription) };
    });
  }

  public async claimDueRenewals(
    now: Date,
    cutoff: Date,
    limit: number,
  ): Promise<readonly RenewalClaim[]> {
    const retry = [...this.attempts.values()].find(
      (attempt) => attempt.kind === 'renewal' && attempt.status === 'creating',
    );

    const currentSubscription = this.subscription;

    if (
      retry !== undefined &&
      currentSubscription !== null &&
      currentSubscription.paymentMethodId !== null
    ) {
      return this.publishRenewalClaims(
        [{ ...cloneAttempt(retry), paymentMethodId: currentSubscription.paymentMethodId }].slice(
          0,
          limit,
        ),
      );
    }

    const subscription = this.subscription;

    if (
      limit < 1 ||
      subscription === null ||
      subscription.status !== 'active' ||
      !subscription.autoRenew ||
      subscription.paymentMethodId === null ||
      subscription.expiresAt === null ||
      subscription.expiresAt <= now ||
      subscription.expiresAt > cutoff
    ) {
      return [];
    }

    const alreadyClaimed = [...this.attempts.values()].some(
      (attempt) =>
        attempt.kind === 'renewal' &&
        attempt.renewsExpiresAt?.getTime() === subscription.expiresAt?.getTime() &&
        ['creating', 'pending', 'succeeded'].includes(attempt.status),
    );

    if (alreadyClaimed) {
      return [];
    }

    const attempt: PaymentAttemptSnapshot = {
      id: randomUUID(),
      subscriptionId: subscription.id,
      userId: subscription.userId,
      providerPaymentId: null,
      kind: 'renewal',
      status: 'creating',
      idempotencyKey: randomUUID(),
      renewsExpiresAt: new Date(subscription.expiresAt.getTime()),
      returnUrl: null,
      confirmationUrl: null,
    };
    this.attempts.set(attempt.id, attempt);
    return this.publishRenewalClaims([
      { ...cloneAttempt(attempt), paymentMethodId: subscription.paymentMethodId },
    ]);
  }

  public async executeRenewalClaim(
    claim: RenewalClaim,
    now: Date,
    createPayment: (validatedClaim: RenewalClaim) => Promise<RenewalProviderPayment>,
  ): Promise<RenewalClaimExecutionResult> {
    return this.withSubscriptionLock(async () => {
      const attempt = this.attempts.get(claim.id);
      const subscription = this.subscription;

      if (
        attempt === undefined ||
        subscription === null ||
        attempt.kind !== 'renewal' ||
        attempt.status !== 'creating' ||
        attempt.providerPaymentId !== null ||
        attempt.subscriptionId !== claim.subscriptionId ||
        attempt.userId !== claim.userId ||
        attempt.idempotencyKey !== claim.idempotencyKey ||
        subscription.id !== claim.subscriptionId ||
        subscription.status !== 'active' ||
        !subscription.autoRenew ||
        subscription.paymentMethodId === null ||
        subscription.expiresAt === null ||
        attempt.renewsExpiresAt?.getTime() !== subscription.expiresAt.getTime() ||
        subscription.expiresAt <= now
      ) {
        return { kind: 'skipped' };
      }

      const validatedClaim: RenewalClaim = {
        ...cloneAttempt(attempt),
        paymentMethodId: subscription.paymentMethodId,
      };
      const payment = await createPayment(validatedClaim);
      const attached = await this.attachProviderPayment({
        attemptId: validatedClaim.id,
        userId: validatedClaim.userId,
        providerPaymentId: payment.providerPaymentId,
        providerStatus: payment.providerStatus,
        confirmationUrl: null,
        rawPayload: payment.rawPayload,
      });

      if (attached.kind !== 'attached') {
        return { kind: 'skipped' };
      }

      return { kind: 'created', providerStatus: payment.providerStatus };
    });
  }

  public async expireElapsedSubscriptions(now: Date): Promise<number> {
    if (
      this.subscription?.status === 'active' &&
      this.subscription.expiresAt !== null &&
      this.subscription.expiresAt <= now
    ) {
      this.subscription = { ...this.subscription, status: 'expired' };
      return 1;
    }

    return 0;
  }

  public seedSubscription(subscription: PaymentSubscriptionSnapshot): void {
    this.subscription = cloneSubscription(subscription);
  }

  public peekSubscription(): PaymentSubscriptionSnapshot | null {
    return this.subscription === null ? null : cloneSubscription(this.subscription);
  }

  public peekAttempts(): readonly PaymentAttemptSnapshot[] {
    return [...this.attempts.values()].map(cloneAttempt);
  }

  public eventCount(): number {
    return this.events.size;
  }

  public setAfterRenewalClaim(hook: () => Promise<void>): void {
    this.afterRenewalClaim = hook;
  }

  private async publishRenewalClaims(
    claims: readonly RenewalClaim[],
  ): Promise<readonly RenewalClaim[]> {
    const hook = this.afterRenewalClaim;
    this.afterRenewalClaim = null;

    if (claims.length > 0 && hook !== null) {
      await hook();
    }

    return claims;
  }

  private async withSubscriptionLock<T>(action: () => Promise<T>): Promise<T> {
    const previous = this.subscriptionLock;
    let release = (): void => undefined;
    this.subscriptionLock = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;

    try {
      return await action();
    } finally {
      release();
    }
  }
}
