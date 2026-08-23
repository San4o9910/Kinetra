export type PushNotificationType = 'workout_reminder' | 'weekly_survey_reminder';

export const MAX_ENABLED_PUSH_SUBSCRIPTIONS_PER_USER = 10;

export interface PushSubscriptionInput {
  readonly userId: string;
  readonly endpoint: string;
  readonly p256dh: string;
  readonly auth: string;
  readonly expirationTime: Date | null;
  readonly userAgent: string | null;
}

export interface DuePushUser {
  readonly userId: string;
  readonly effectiveTimezone: string;
  readonly localDate: string;
  readonly localDayOfWeek: number;
  readonly workoutReminders: boolean;
  readonly weeklySurveyReminder: boolean;
}

export interface PushNotificationEvent {
  readonly userId: string;
  readonly notificationType: PushNotificationType;
  readonly occurrenceKey: string;
}

export interface PushDeliveryClaim {
  readonly id: string;
  readonly subscriptionId: string;
  readonly userId: string;
  readonly notificationType: PushNotificationType;
  readonly occurrenceKey: string;
}

export interface PushDeliveryClaimResult {
  readonly claims: readonly PushDeliveryClaim[];
  readonly duplicates: number;
}

export interface PushDeviceSubscription {
  readonly endpoint: string;
  readonly p256dh: string;
  readonly auth: string;
  readonly expirationTime: Date | null;
}

export type PushSendResult =
  | { readonly kind: 'sent' }
  | { readonly kind: 'invalid'; readonly errorCode: 'http_404' | 'http_410' }
  | { readonly kind: 'failed'; readonly errorCode: string };

export type PushDeliveryExecutionResult = 'sent' | 'invalidated' | 'failed' | 'skipped';

export interface PushRepository {
  upsertSubscription(input: PushSubscriptionInput): Promise<boolean>;
  disableSubscription(userId: string, endpoint: string, now: Date): Promise<void>;
  findDueUsers(now: Date): Promise<readonly DuePushUser[]>;
  claimDeliveries(event: PushNotificationEvent, now: Date): Promise<PushDeliveryClaimResult>;
  executeDeliveryClaim(
    claim: PushDeliveryClaim,
    now: Date,
    send: (subscription: PushDeviceSubscription) => Promise<PushSendResult>,
  ): Promise<PushDeliveryExecutionResult>;
}
