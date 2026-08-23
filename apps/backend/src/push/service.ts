import type { PushPublicKeyResponse, PushSubscriptionResponse } from '@kinetra/shared';

import { HttpError } from '../auth/errors.js';
import type { PushRepository } from './repository.js';
import { pushSubscriptionSchema, pushUnsubscribeSchema } from './schema.js';

const validationError = (code: string, fallback: string, issues: readonly unknown[]): HttpError => {
  const firstIssue = issues[0];
  const message =
    typeof firstIssue === 'object' &&
    firstIssue !== null &&
    'message' in firstIssue &&
    typeof firstIssue.message === 'string'
      ? firstIssue.message
      : fallback;

  return new HttpError(400, code, message);
};

const normalizeUserAgent = (userAgent: string | undefined): string | null => {
  const normalized = userAgent?.trim();
  return normalized === undefined || normalized.length === 0 ? null : normalized.slice(0, 512);
};

export class PushService {
  public constructor(
    private readonly repository: PushRepository,
    private readonly publicKey: string | null,
  ) {}

  public async getPublicKey(): Promise<PushPublicKeyResponse> {
    if (this.publicKey === null) {
      throw new HttpError(503, 'PUSH_NOT_CONFIGURED', 'Push notifications are not configured.');
    }

    return { public_key: this.publicKey };
  }

  public async subscribe(
    userId: string,
    body: unknown,
    userAgent: string | undefined,
  ): Promise<PushSubscriptionResponse> {
    if (this.publicKey === null) {
      throw new HttpError(503, 'PUSH_NOT_CONFIGURED', 'Push notifications are not configured.');
    }

    const parsed = pushSubscriptionSchema.safeParse(body);

    if (!parsed.success) {
      throw validationError(
        'INVALID_PUSH_SUBSCRIPTION',
        'The push subscription is invalid.',
        parsed.error.issues,
      );
    }

    const subscription = parsed.data;
    const saved = await this.repository.upsertSubscription({
      userId,
      endpoint: subscription.endpoint,
      p256dh: subscription.keys.p256dh,
      auth: subscription.keys.auth,
      expirationTime:
        subscription.expirationTime === null ? null : new Date(subscription.expirationTime),
      userAgent: normalizeUserAgent(userAgent),
    });

    if (!saved) {
      throw new HttpError(
        409,
        'PUSH_SUBSCRIPTION_CONFLICT',
        'The push subscription could not be registered.',
      );
    }

    return { subscribed: true };
  }

  public async unsubscribe(userId: string, body: unknown, now: Date): Promise<void> {
    const parsed = pushUnsubscribeSchema.safeParse(body);

    if (!parsed.success) {
      throw validationError(
        'INVALID_PUSH_UNSUBSCRIBE',
        'The push unsubscribe request is invalid.',
        parsed.error.issues,
      );
    }

    await this.repository.disableSubscription(userId, parsed.data.endpoint, now);
  }
}
