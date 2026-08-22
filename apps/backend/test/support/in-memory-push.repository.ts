import { randomUUID } from 'node:crypto';

import {
  MAX_ENABLED_PUSH_SUBSCRIPTIONS_PER_USER,
  type DuePushUser,
  type PushDeliveryClaim,
  type PushDeliveryClaimResult,
  type PushDeliveryExecutionResult,
  type PushDeviceSubscription,
  type PushNotificationEvent,
  type PushRepository,
  type PushSendResult,
  type PushSubscriptionInput,
} from '../../src/push/repository.js';

interface StoredSubscription extends PushDeviceSubscription {
  readonly id: string;
  userId: string;
  userAgent: string | null;
  disabledAt: Date | null;
  lastSuccessAt: Date | null;
  lastFailureAt: Date | null;
}

interface StoredDelivery extends PushDeliveryClaim {
  status: 'claimed' | 'sent' | 'failed' | 'invalidated';
}

const cloneDate = (value: Date | null): Date | null =>
  value === null ? null : new Date(value.getTime());

const cloneSubscription = (subscription: StoredSubscription): StoredSubscription => ({
  ...subscription,
  expirationTime: cloneDate(subscription.expirationTime),
  disabledAt: cloneDate(subscription.disabledAt),
  lastSuccessAt: cloneDate(subscription.lastSuccessAt),
  lastFailureAt: cloneDate(subscription.lastFailureAt),
});

export class InMemoryPushRepository implements PushRepository {
  private readonly users = new Set<string>();
  private readonly subscriptions = new Map<string, StoredSubscription>();
  private readonly deliveries = new Map<string, StoredDelivery>();
  private dueUsers: DuePushUser[] = [];

  public constructor(userIds: readonly string[]) {
    userIds.forEach((userId) => this.users.add(userId));
  }

  public async upsertSubscription(input: PushSubscriptionInput): Promise<boolean> {
    if (!this.users.has(input.userId)) {
      return false;
    }

    const existing = this.subscriptions.get(input.endpoint);

    if (
      existing !== undefined &&
      existing.userId !== input.userId &&
      (existing.p256dh !== input.p256dh || existing.auth !== input.auth)
    ) {
      return false;
    }

    const requiresEnabledSlot =
      existing === undefined || existing.userId !== input.userId || existing.disabledAt !== null;
    const enabledCount = [...this.subscriptions.values()].filter(
      (subscription) => subscription.userId === input.userId && subscription.disabledAt === null,
    ).length;

    if (requiresEnabledSlot && enabledCount >= MAX_ENABLED_PUSH_SUBSCRIPTIONS_PER_USER) {
      return false;
    }

    this.subscriptions.set(input.endpoint, {
      id: existing?.id ?? randomUUID(),
      userId: input.userId,
      endpoint: input.endpoint,
      p256dh: input.p256dh,
      auth: input.auth,
      expirationTime: cloneDate(input.expirationTime),
      userAgent: input.userAgent,
      disabledAt: null,
      lastSuccessAt: existing?.lastSuccessAt ?? null,
      lastFailureAt: existing?.lastFailureAt ?? null,
    });
    return true;
  }

  public async disableSubscription(userId: string, endpoint: string, now: Date): Promise<void> {
    const subscription = this.subscriptions.get(endpoint);

    if (subscription !== undefined && subscription.userId === userId) {
      subscription.disabledAt ??= new Date(now.getTime());
    }
  }

  public async findDueUsers(): Promise<readonly DuePushUser[]> {
    return this.dueUsers.map((user) => ({ ...user }));
  }

  public async claimDeliveries(
    event: PushNotificationEvent,
    now: Date,
  ): Promise<PushDeliveryClaimResult> {
    const eligible = [...this.subscriptions.values()].filter(
      (subscription) =>
        subscription.userId === event.userId &&
        subscription.disabledAt === null &&
        (subscription.expirationTime === null || subscription.expirationTime > now),
    );
    const claims: PushDeliveryClaim[] = [];

    for (const subscription of eligible) {
      const key = this.deliveryKey(
        subscription.id,
        event.userId,
        event.notificationType,
        event.occurrenceKey,
      );

      if (this.deliveries.has(key)) {
        continue;
      }

      const delivery: StoredDelivery = {
        id: randomUUID(),
        subscriptionId: subscription.id,
        userId: event.userId,
        notificationType: event.notificationType,
        occurrenceKey: event.occurrenceKey,
        status: 'claimed',
      };
      this.deliveries.set(key, delivery);
      claims.push({
        id: delivery.id,
        subscriptionId: delivery.subscriptionId,
        userId: delivery.userId,
        notificationType: delivery.notificationType,
        occurrenceKey: delivery.occurrenceKey,
      });
    }

    return { claims, duplicates: eligible.length - claims.length };
  }

  public async executeDeliveryClaim(
    claim: PushDeliveryClaim,
    now: Date,
    send: (subscription: PushDeviceSubscription) => Promise<PushSendResult>,
  ): Promise<PushDeliveryExecutionResult> {
    const key = this.deliveryKey(
      claim.subscriptionId,
      claim.userId,
      claim.notificationType,
      claim.occurrenceKey,
    );
    const delivery = this.deliveries.get(key);
    const subscription = [...this.subscriptions.values()].find(
      (candidate) => candidate.id === claim.subscriptionId,
    );

    if (
      delivery === undefined ||
      delivery.id !== claim.id ||
      delivery.status !== 'claimed' ||
      subscription === undefined ||
      subscription.userId !== claim.userId ||
      subscription.disabledAt !== null ||
      (subscription.expirationTime !== null && subscription.expirationTime <= now)
    ) {
      return 'skipped';
    }

    const outcome = await send(cloneSubscription(subscription));

    if (outcome.kind === 'sent') {
      delivery.status = 'sent';
      subscription.lastSuccessAt = new Date(now.getTime());
      return 'sent';
    }

    subscription.lastFailureAt = new Date(now.getTime());

    if (outcome.kind === 'invalid') {
      delivery.status = 'invalidated';
      subscription.disabledAt = new Date(now.getTime());
      return 'invalidated';
    }

    delivery.status = 'failed';
    return 'failed';
  }

  public setDueUsers(users: readonly DuePushUser[]): void {
    this.dueUsers = users.map((user) => ({ ...user }));
  }

  public peekSubscriptions(): readonly StoredSubscription[] {
    return [...this.subscriptions.values()].map(cloneSubscription);
  }

  public peekDeliveries(): readonly StoredDelivery[] {
    return [...this.deliveries.values()].map((delivery) => ({ ...delivery }));
  }

  private deliveryKey(
    subscriptionId: string,
    userId: string,
    type: string,
    occurrenceKey: string,
  ): string {
    return `${subscriptionId}:${userId}:${type}:${occurrenceKey}`;
  }
}
