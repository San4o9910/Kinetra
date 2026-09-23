import type { Pool } from 'pg';
import { PostgresPushRepository } from '../push/postgres-push.repository.js';
import type { PushSender } from '../push/webpush-sender.js';
export class TrainingReminders {
  public constructor(
    private readonly pool: Pool,
    private readonly sender: PushSender,
  ) {}
  public async run(now = new Date()) {
    const repository = new PostgresPushRepository(this.pool);
    const due = await this.pool.query(
      `SELECT DISTINCT u.id,to_char($1::timestamptz AT TIME ZONE tz.name,'YYYY-MM-DD') local_date
   FROM users u JOIN pg_timezone_names tz ON tz.name=u.timezone
   JOIN training_students s ON s.client_id=u.id AND s.archived_at IS NULL
   JOIN trainer_profiles t ON t.user_id=s.trainer_id AND t.is_active
   JOIN training_plans p ON p.student_id=s.id AND p.status='published'
   JOIN training_workouts w ON w.plan_id=p.id
   LEFT JOIN training_logs l ON l.workout_id=w.id
   WHERE COALESCE(u.notification_preferences->>'workout_reminders','false')='true'
   AND u.notification_preferences->>'reminder_time'=to_char($1::timestamptz AT TIME ZONE tz.name,'HH24:MI')
   AND w.scheduled_date=($1::timestamptz AT TIME ZONE tz.name)::date AND l.completed_at IS NULL
   AND EXISTS(SELECT 1 FROM push_subscriptions ps WHERE ps.user_id=u.id AND ps.disabled_at IS NULL)
   ORDER BY u.id LIMIT 500`,
      [now],
    );
    let sent = 0;
    for (const u of due.rows) {
      const key = `personal:${u.id}:${u.local_date}`;
      const claimed = await repository.claimDeliveries(
        { userId: u.id, notificationType: 'workout_reminder', occurrenceKey: key },
        now,
      );
      for (const claim of claimed.claims) {
        const result = await repository.executeDeliveryClaim(claim, now, async (subscription) => {
          const enabled = await this.pool.query(
            `SELECT 1 FROM users u JOIN training_students s ON s.client_id=u.id AND s.archived_at IS NULL JOIN trainer_profiles t ON t.user_id=s.trainer_id AND t.is_active JOIN training_plans p ON p.student_id=s.id AND p.status='published' JOIN training_workouts w ON w.plan_id=p.id LEFT JOIN training_logs l ON l.workout_id=w.id WHERE u.id=$1 AND u.notification_preferences->>'workout_reminders'='true' AND w.scheduled_date=$2::date AND l.completed_at IS NULL LIMIT 1`,
            [u.id, u.local_date],
          );
          if (!enabled.rowCount) return { kind: 'failed', errorCode: 'preference_changed' };
          return this.sender.send(subscription, {
            type: 'workout_reminder',
            title: 'Сегодня ваша тренировка',
            body: 'Тренер подготовил занятие. Откройте расписание, когда будете готовы.',
            url: '/schedule',
            occurrence_key: key,
          });
        });
        if (result === 'sent') sent++;
      }
    }
    return { selected: due.rowCount ?? 0, sent };
  }
}
