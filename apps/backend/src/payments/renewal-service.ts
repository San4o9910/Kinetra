import type { Clock } from '../auth/service.js';
import type { PaymentsRepository, RenewalClaim } from './repository.js';
import { SUBSCRIPTION_AMOUNT_VALUE, SUBSCRIPTION_CURRENCY } from './service.js';
import {
  type YooKassaClient,
  YooKassaApiError,
  type YooKassaCreatePaymentInput,
} from './yookassa-client.js';

const MILLISECONDS_PER_DAY = 24 * 60 * 60 * 1000;

export interface RenewalFailureNotification {
  readonly userId: string;
  readonly subscriptionId: string;
  readonly attemptId: string;
  readonly reason: 'provider_rejected' | 'provider_unavailable' | 'payment_cancelled';
}

export interface RenewalFailureNotifier {
  notifyRenewalFailure(notification: RenewalFailureNotification): Promise<void>;
}

export class ConsoleRenewalFailureNotifier implements RenewalFailureNotifier {
  public async notifyRenewalFailure(notification: RenewalFailureNotification): Promise<void> {
    console.warn('Kinetra subscription renewal requires user attention.', notification);
  }
}

export interface RenewalRunSummary {
  readonly expired: number;
  readonly claimed: number;
  readonly submitted: number;
  readonly failed: number;
  readonly skipped: number;
}

type RenewalSubmissionOutcome = 'submitted' | 'failed' | 'skipped';

export class RenewalService {
  public constructor(
    private readonly repository: PaymentsRepository,
    private readonly client: YooKassaClient,
    private readonly clock: Clock,
    private readonly notifier: RenewalFailureNotifier,
  ) {}

  public async run(limit = 100): Promise<RenewalRunSummary> {
    const now = this.clock.now();
    const expired = await this.repository.expireElapsedSubscriptions(now);
    const claims = await this.repository.claimDueRenewals(
      now,
      new Date(now.getTime() + MILLISECONDS_PER_DAY),
      limit,
    );
    let submitted = 0;
    let failed = 0;
    let skipped = 0;

    for (const claim of claims) {
      const outcome = await this.submitClaim(claim);

      if (outcome === 'submitted') {
        submitted += 1;
      } else if (outcome === 'failed') {
        failed += 1;
      } else {
        skipped += 1;
      }
    }

    return { expired, claimed: claims.length, submitted, failed, skipped };
  }

  private async submitClaim(claim: RenewalClaim): Promise<RenewalSubmissionOutcome> {
    let execution: Awaited<ReturnType<PaymentsRepository['executeRenewalClaim']>>;
    try {
      execution = await this.repository.executeRenewalClaim(
        claim,
        this.clock.now(),
        async (validatedClaim) => {
          const input: YooKassaCreatePaymentInput = {
            amount: { value: SUBSCRIPTION_AMOUNT_VALUE, currency: SUBSCRIPTION_CURRENCY },
            capture: true,
            payment_method_id: validatedClaim.paymentMethodId,
            description: 'Продление подписки Kinetra — 1 месяц',
            metadata: {
              user_id: validatedClaim.userId,
              subscription_id: validatedClaim.subscriptionId,
              attempt_id: validatedClaim.id,
              type: 'subscription',
            },
          };
          const payment = await this.client.createPayment(input, validatedClaim.idempotencyKey);

          return {
            providerPaymentId: payment.id,
            providerStatus:
              payment.status === 'canceled'
                ? 'canceled'
                : payment.status === 'succeeded'
                  ? 'succeeded'
                  : 'pending',
            rawPayload: payment as Readonly<Record<string, unknown>>,
          };
        },
      );
    } catch (error) {
      const providerError = error instanceof YooKassaApiError ? error : null;

      if (providerError !== null && !providerError.retryable) {
        await this.repository.markAttemptFailed(claim.id, {
          provider_error: providerError.statusCode ?? 'configuration',
        });
      }

      await this.notifier.notifyRenewalFailure({
        userId: claim.userId,
        subscriptionId: claim.subscriptionId,
        attemptId: claim.id,
        reason:
          providerError !== null && !providerError.retryable
            ? 'provider_rejected'
            : 'provider_unavailable',
      });
      return 'failed';
    }

    if (execution.kind === 'skipped') {
      return 'skipped';
    }

    if (execution.providerStatus === 'canceled') {
      await this.notifier.notifyRenewalFailure({
        userId: claim.userId,
        subscriptionId: claim.subscriptionId,
        attemptId: claim.id,
        reason: 'payment_cancelled',
      });
      return 'failed';
    }

    return 'submitted';
  }
}
