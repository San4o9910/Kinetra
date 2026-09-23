import type { Pool } from 'pg';

export interface FreeBetaAccessChecker {
  hasFreeBetaAccess(userId: string): Promise<boolean>;
}

// The approved test cohort contains at most fifteen current trainee accounts.
// This grants training access only; billing records and trainer permissions stay separate.
export class PostgresFreeBetaAccessChecker implements FreeBetaAccessChecker {
  public constructor(
    private readonly pool: Pick<Pool, 'query'>,
    private readonly enabled: boolean,
  ) {}

  public async hasFreeBetaAccess(userId: string): Promise<boolean> {
    if (!this.enabled) return false;
    const result = await this.pool.query(
      `SELECT 1 FROM (
         SELECT candidate.id
         FROM users AS candidate
         WHERE candidate.requested_role = 'trainee'
           AND NOT EXISTS (
             SELECT 1 FROM trainer_profiles AS trainer
             WHERE trainer.user_id = candidate.id AND trainer.is_active = true
           )
         ORDER BY candidate.created_at, candidate.id
         LIMIT 15
       ) AS beta_cohort
       WHERE beta_cohort.id = $1`,
      [userId],
    );
    return result.rowCount === 1;
  }
}
