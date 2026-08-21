import type { Pool } from 'pg';

export interface SubscriptionAccessChecker {
  hasActiveSubscription(userId: string, now: Date): Promise<boolean>;
}

export class PostgresSubscriptionAccessChecker implements SubscriptionAccessChecker {
  public constructor(private readonly pool: Pool) {}

  public async hasActiveSubscription(userId: string, now: Date): Promise<boolean> {
    const result = await this.pool.query(
      `SELECT 1
       FROM subscriptions
       WHERE user_id = $1
         AND status = 'active'
         AND starts_at IS NOT NULL
         AND starts_at <= $2
         AND expires_at IS NOT NULL
         AND expires_at > $2
       LIMIT 1`,
      [userId, now],
    );

    return result.rowCount === 1;
  }
}
