import type { Clock } from '../auth/service.js';
import type { SubscriptionAccessChecker } from '../payments/subscription-access.js';
import type { ProgramRepository } from '../program/repository.js';
import type { ProgressRepository } from '../progress/repository.js';
import type {
  DuePushUser,
  PushDeliveryClaim,
  PushDeliveryExecutionResult,
  PushDeviceSubscription,
  PushNotificationEvent,
  PushNotificationType,
  PushRepository,
  PushSendResult,
} from './repository.js';
import type { PushPayload, PushSender } from './webpush-sender.js';

const DEFAULT_SEND_CONCURRENCY = 8;

interface ClaimedDelivery {
  readonly claim: PushDeliveryClaim;
  readonly payload: PushPayload;
}

export interface NotificationRunSummary {
  readonly selected: number;
  readonly claimed: number;
  readonly sent: number;
  readonly invalidated: number;
  readonly skipped: number;
  readonly failed: number;
  readonly duplicated: number;
  readonly byType: Readonly<Record<PushNotificationType, NotificationTypeRunSummary>>;
  readonly errorCategories: Readonly<Record<NotificationErrorCategory, number>>;
}

export interface NotificationTypeRunSummary {
  readonly selected: number;
  readonly claimed: number;
  readonly sent: number;
  readonly invalidated: number;
  readonly skipped: number;
  readonly failed: number;
  readonly duplicated: number;
}

export type NotificationErrorCategory =
  | 'subscription_gone'
  | 'endpoint_address_blocked'
  | 'push_service_http'
  | 'network_timeout'
  | 'network'
  | 'payload'
  | 'configuration'
  | 'sender';

interface MutableNotificationTypeRunSummary {
  selected: number;
  claimed: number;
  sent: number;
  invalidated: number;
  skipped: number;
  failed: number;
  duplicated: number;
}

interface CompletedDelivery {
  readonly notificationType: PushNotificationType;
  readonly outcome: PushDeliveryExecutionResult;
  readonly errorCategory: NotificationErrorCategory | null;
}

const createTypeSummary = (): MutableNotificationTypeRunSummary => ({
  selected: 0,
  claimed: 0,
  sent: 0,
  invalidated: 0,
  skipped: 0,
  failed: 0,
  duplicated: 0,
});

const createErrorCategories = (): Record<NotificationErrorCategory, number> => ({
  subscription_gone: 0,
  endpoint_address_blocked: 0,
  push_service_http: 0,
  network_timeout: 0,
  network: 0,
  payload: 0,
  configuration: 0,
  sender: 0,
});

const errorCategoryFor = (errorCode: string): NotificationErrorCategory => {
  if (errorCode === 'http_404' || errorCode === 'http_410') {
    return 'subscription_gone';
  }

  if (errorCode === 'endpoint_address_blocked') {
    return 'endpoint_address_blocked';
  }

  if (/^http_[0-9]{3}$/u.test(errorCode)) {
    return 'push_service_http';
  }

  if (errorCode === 'network_timeout') {
    return 'network_timeout';
  }

  if (errorCode === 'network_error') {
    return 'network';
  }

  if (errorCode === 'invalid_payload' || errorCode === 'payload_too_large') {
    return 'payload';
  }

  if (errorCode === 'not_configured') {
    return 'configuration';
  }

  return 'sender';
};

const failureCodeFrom = (result: PushSendResult | null): string =>
  result === null || result.kind === 'sent' ? 'sender_error' : result.errorCode;

const mapWithConcurrency = async <Input, Output>(
  values: readonly Input[],
  concurrency: number,
  operation: (value: Input) => Promise<Output>,
): Promise<readonly Output[]> => {
  const results: Output[] = new Array<Output>(values.length);
  let nextIndex = 0;

  const worker = async (): Promise<void> => {
    while (nextIndex < values.length) {
      const index = nextIndex;
      nextIndex += 1;
      const value = values[index];

      if (value !== undefined) {
        results[index] = await operation(value);
      }
    }
  };

  const workerCount = Math.min(concurrency, values.length);
  await Promise.all(Array.from({ length: workerCount }, () => worker()));
  return results;
};

export class NotificationSchedulerService {
  public constructor(
    private readonly pushRepository: PushRepository,
    private readonly programRepository: ProgramRepository,
    private readonly progressRepository: ProgressRepository,
    private readonly subscriptionAccess: SubscriptionAccessChecker,
    private readonly sender: PushSender,
    private readonly clock: Clock,
    private readonly sendConcurrency = DEFAULT_SEND_CONCURRENCY,
  ) {
    if (!Number.isInteger(sendConcurrency) || sendConcurrency < 1 || sendConcurrency > 32) {
      throw new Error('Push send concurrency must be an integer between 1 and 32.');
    }
  }

  public async run(): Promise<NotificationRunSummary> {
    const now = this.clock.now();
    const dueUsers = await this.pushRepository.findDueUsers(now);
    const deliveries: ClaimedDelivery[] = [];
    let selected = 0;
    let claimed = 0;
    let skipped = 0;
    let duplicated = 0;
    const byType: Record<PushNotificationType, MutableNotificationTypeRunSummary> = {
      workout_reminder: createTypeSummary(),
      weekly_survey_reminder: createTypeSummary(),
    };
    const errorCategories = createErrorCategories();

    for (const dueUser of dueUsers) {
      if (!(await this.subscriptionAccess.hasActiveSubscription(dueUser.userId, now))) {
        skipped += 1;
        continue;
      }

      const program = await this.programRepository.getProgress(dueUser.userId);
      const week = await this.programRepository.getWeek(dueUser.userId, program.currentWeekNumber);

      if (week === null || week.days.length !== 7) {
        throw new Error(
          `Current program week ${program.currentWeekNumber} is incomplete for push scheduling.`,
        );
      }

      const events: readonly { event: PushNotificationEvent; payload: PushPayload }[] = [
        ...(this.workoutEvent(dueUser, program.currentWeekNumber, week.days) ?? []),
        ...(await this.weeklySurveyEvent(dueUser, program.currentWeekNumber)),
      ];

      if (events.length === 0) {
        skipped += 1;
      }

      for (const candidate of events) {
        const typeSummary = byType[candidate.event.notificationType];
        selected += 1;
        typeSummary.selected += 1;
        const claimResult = await this.pushRepository.claimDeliveries(candidate.event, now);
        claimed += claimResult.claims.length;
        duplicated += claimResult.duplicates;
        typeSummary.claimed += claimResult.claims.length;
        typeSummary.duplicated += claimResult.duplicates;
        deliveries.push(
          ...claimResult.claims.map((deliveryClaim) => ({
            claim: deliveryClaim,
            payload: candidate.payload,
          })),
        );
      }
    }

    const outcomes = await mapWithConcurrency(
      deliveries,
      this.sendConcurrency,
      async ({ claim, payload }): Promise<CompletedDelivery> => {
        const sendState: { result: PushSendResult | null } = { result: null };
        const send = async (subscription: PushDeviceSubscription): Promise<PushSendResult> => {
          try {
            sendState.result = await this.sender.send(subscription, payload);
          } catch {
            sendState.result = { kind: 'failed', errorCode: 'sender_error' };
          }

          return sendState.result;
        };
        const outcome = await this.pushRepository.executeDeliveryClaim(claim, now, send);
        const errorCategory =
          outcome === 'failed' || outcome === 'invalidated'
            ? errorCategoryFor(failureCodeFrom(sendState.result))
            : null;

        return { notificationType: claim.notificationType, outcome, errorCategory };
      },
    );
    let sent = 0;
    let invalidated = 0;
    let failed = 0;

    for (const outcome of outcomes) {
      const typeSummary = byType[outcome.notificationType];

      if (outcome.outcome === 'sent') {
        sent += 1;
        typeSummary.sent += 1;
      } else if (outcome.outcome === 'invalidated') {
        invalidated += 1;
        typeSummary.invalidated += 1;
      } else if (outcome.outcome === 'failed') {
        failed += 1;
        typeSummary.failed += 1;
      } else {
        skipped += 1;
        typeSummary.skipped += 1;
      }

      if (outcome.errorCategory !== null) {
        errorCategories[outcome.errorCategory] += 1;
      }
    }

    return {
      selected,
      claimed,
      sent,
      invalidated,
      skipped,
      failed,
      duplicated,
      byType,
      errorCategories,
    };
  }

  private workoutEvent(
    dueUser: DuePushUser,
    programWeek: number,
    days: readonly {
      readonly dayOfWeek: number;
      readonly videoId: string;
      readonly completedAt: Date | null;
      readonly mediaAvailable: boolean;
    }[],
  ): readonly { event: PushNotificationEvent; payload: PushPayload }[] | null {
    if (!dueUser.workoutReminders) {
      return null;
    }

    const workout = days.find((day) => day.dayOfWeek === dueUser.localDayOfWeek);

    if (workout === undefined || workout.completedAt !== null || !workout.mediaAvailable) {
      return null;
    }

    const occurrenceKey = `workout:${programWeek}:${workout.videoId}:${dueUser.localDate}`;
    return [
      {
        event: {
          userId: dueUser.userId,
          notificationType: 'workout_reminder',
          occurrenceKey,
        },
        payload: {
          type: 'workout_reminder',
          title: 'Время тренировки',
          body: 'Сегодня по плану тренировка. Откройте расписание Kinetra.',
          url: '/schedule',
          occurrence_key: occurrenceKey,
        },
      },
    ];
  }

  private async weeklySurveyEvent(
    dueUser: DuePushUser,
    programWeek: number,
  ): Promise<readonly { event: PushNotificationEvent; payload: PushPayload }[]> {
    if (!dueUser.weeklySurveyReminder || dueUser.localDayOfWeek !== 7) {
      return [];
    }

    const metrics = await this.progressRepository.getMetrics(dueUser.userId);

    if (metrics === null || metrics.some((metric) => metric.programWeek === programWeek)) {
      return [];
    }

    const occurrenceKey = `weekly-survey:${programWeek}`;
    return [
      {
        event: {
          userId: dueUser.userId,
          notificationType: 'weekly_survey_reminder',
          occurrenceKey,
        },
        payload: {
          type: 'weekly_survey_reminder',
          title: 'Еженедельная самооценка',
          body: 'Отметьте самочувствие и прогресс за текущую неделю.',
          url: '/progress',
          occurrence_key: occurrenceKey,
        },
      },
    ];
  }
}
