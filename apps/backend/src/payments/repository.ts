import type { SubscriptionProvider, SubscriptionStatus } from '@kinetra/shared';

export type PaymentAttemptKind = 'initial' | 'renewal';
export type PaymentAttemptStatus =
  'creating' | 'pending' | 'succeeded' | 'cancelled' | 'refunded' | 'failed';

export interface PaymentAttemptSnapshot {
  readonly id: string;
  readonly subscriptionId: string;
  readonly userId: string;
  readonly providerPaymentId: string | null;
  readonly kind: PaymentAttemptKind;
  readonly status: PaymentAttemptStatus;
  readonly idempotencyKey: string;
  readonly renewsExpiresAt: Date | null;
  readonly returnUrl: string | null;
  readonly confirmationUrl: string | null;
}

export interface PaymentSubscriptionSnapshot {
  readonly id: string;
  readonly userId: string;
  readonly provider: SubscriptionProvider;
  readonly status: SubscriptionStatus;
  readonly startsAt: Date | null;
  readonly expiresAt: Date | null;
  readonly amountMinor: number | null;
  readonly currency: string | null;
  readonly autoRenew: boolean;
  readonly paymentMethodId: string | null;
}

export type InitialPaymentClaim =
  | { readonly kind: 'user_not_found' }
  | { readonly kind: 'subscription_active' }
  | { readonly kind: 'claimed'; readonly attempt: PaymentAttemptSnapshot };

export interface ClaimInitialPaymentInput {
  readonly userId: string;
  readonly returnUrl: string;
  readonly idempotencyKey: string;
  readonly amountMinor: number;
  readonly currency: string;
  readonly now: Date;
}

export interface AttachProviderPaymentInput {
  readonly attemptId: string;
  readonly userId: string;
  readonly providerPaymentId: string;
  readonly providerStatus: 'pending' | 'succeeded' | 'canceled';
  readonly confirmationUrl: string | null;
  readonly rawPayload: Readonly<Record<string, unknown>>;
}

export type TerminalPaymentAttemptStatus = Extract<
  PaymentAttemptStatus,
  'succeeded' | 'cancelled' | 'refunded' | 'failed'
>;

export type AttachProviderPaymentResult =
  | { readonly kind: 'attached' }
  | { readonly kind: 'terminal'; readonly status: TerminalPaymentAttemptStatus }
  | { readonly kind: 'stale' };

export interface VerifiedPaymentEvent {
  readonly eventId: string;
  readonly eventType: 'payment.succeeded' | 'payment.canceled' | 'refund.succeeded';
  readonly providerObjectId: string;
  readonly paymentId: string;
  readonly userId: string;
  readonly subscriptionId: string;
  readonly attemptId: string;
  readonly outcome: 'succeeded' | 'cancelled' | 'refunded' | 'ignored';
  readonly paymentMethodId: string | null;
  readonly paymentMethodSaved: boolean;
  readonly rawPayload: Readonly<Record<string, unknown>>;
}

export type ApplyPaymentEventResult = 'applied' | 'duplicate' | 'ignored';

export interface SubscriptionLookup {
  readonly userExists: boolean;
  readonly subscription: PaymentSubscriptionSnapshot | null;
}

export interface RenewalClaim extends PaymentAttemptSnapshot {
  readonly paymentMethodId: string;
}

export interface RenewalProviderPayment {
  readonly providerPaymentId: string;
  readonly providerStatus: 'pending' | 'succeeded' | 'canceled';
  readonly rawPayload: Readonly<Record<string, unknown>>;
}

export type RenewalClaimExecutionResult =
  | { readonly kind: 'skipped' }
  | {
      readonly kind: 'created';
      readonly providerStatus: RenewalProviderPayment['providerStatus'];
    };

export interface PaymentsRepository {
  claimInitialPayment(input: ClaimInitialPaymentInput): Promise<InitialPaymentClaim>;
  attachProviderPayment(input: AttachProviderPaymentInput): Promise<AttachProviderPaymentResult>;
  markAttemptFailed(
    attemptId: string,
    rawPayload: Readonly<Record<string, unknown>>,
  ): Promise<void>;
  applyVerifiedEvent(event: VerifiedPaymentEvent, now: Date): Promise<ApplyPaymentEventResult>;
  cancelAutoRenew(userId: string, now: Date): Promise<SubscriptionLookup>;
  claimDueRenewals(now: Date, cutoff: Date, limit: number): Promise<readonly RenewalClaim[]>;
  executeRenewalClaim(
    claim: RenewalClaim,
    now: Date,
    createPayment: (validatedClaim: RenewalClaim) => Promise<RenewalProviderPayment>,
  ): Promise<RenewalClaimExecutionResult>;
  expireElapsedSubscriptions(now: Date): Promise<number>;
}
