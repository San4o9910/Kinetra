import type { Pool, PoolClient, QueryResultRow } from 'pg';

import type {
  AuthRepository,
  CreateUserInput,
  CreateUserResult,
  OneTimeTokenInput,
  RevokeRefreshSessionInFamilyInput,
  RefreshSessionInput,
  RotateRefreshSessionInput,
  RotateRefreshSessionResult,
  UserRecord,
} from './repository.js';

interface UserRow extends QueryResultRow {
  id: string;
  email: string | null;
  phone: string | null;
  password_hash: string;
  email_verified: boolean;
  created_at: Date | string;
  updated_at: Date | string;
}

interface RefreshSessionOwnerRow extends QueryResultRow {
  user_id: string;
}

interface RotationRow extends QueryResultRow {
  refresh_id: string;
  refresh_user_id: string;
  refresh_expires_at: Date | string;
  refresh_revoked_at: Date | string | null;
  refresh_replaced_by_token_id: string | null;
}

interface OneTimeTokenRow extends QueryResultRow {
  id: string;
  user_id: string;
  expires_at: Date | string;
  used_at: Date | string | null;
}

interface OneTimeTokenOwnerRow extends QueryResultRow {
  user_id: string;
}

interface RefreshSessionIdentityRow extends QueryResultRow {
  id: string;
  user_id: string;
}

interface TrainerVerificationRequestIdentityRow extends QueryResultRow {
  id: string;
}

const asDate = (value: Date | string): Date =>
  value instanceof Date ? new Date(value.getTime()) : new Date(value);

const mapUser = (row: UserRow): UserRecord => ({
  id: row.id,
  email: row.email,
  phone: row.phone,
  passwordHash: row.password_hash,
  emailVerified: row.email_verified,
  createdAt: asDate(row.created_at),
  updatedAt: asDate(row.updated_at),
});

const isUniqueViolation = (error: unknown): error is { code: string; constraint?: string } =>
  typeof error === 'object' &&
  error !== null &&
  'code' in error &&
  (error as { code?: unknown }).code === '23505';

export type AuthRefreshMutationOperation = 'rotate' | 'logout';

export interface PostgresAuthRepositoryHooks {
  readonly afterUserLocked?: (
    operation: AuthRefreshMutationOperation,
    userId: string,
  ) => Promise<void>;
}

export class PostgresAuthRepository implements AuthRepository {
  public constructor(
    private readonly pool: Pool,
    private readonly hooks: PostgresAuthRepositoryHooks = {},
  ) {}

  public async findUserByEmail(email: string): Promise<UserRecord | null> {
    const result = await this.pool.query<UserRow>(
      `SELECT id, email, phone, password_hash, email_verified, created_at, updated_at
       FROM users
       WHERE email = $1
       LIMIT 1`,
      [email],
    );
    const row = result.rows[0];
    return row === undefined ? null : mapUser(row);
  }

  public async findUserByPhone(phone: string): Promise<UserRecord | null> {
    const result = await this.pool.query<UserRow>(
      `SELECT id, email, phone, password_hash, email_verified, created_at, updated_at
       FROM users
       WHERE phone = $1
       LIMIT 1`,
      [phone],
    );
    const row = result.rows[0];
    return row === undefined ? null : mapUser(row);
  }

  public async createUser(input: CreateUserInput): Promise<CreateUserResult> {
    const client = await this.pool.connect();

    try {
      await client.query('BEGIN');
      const result = await client.query<UserRow>(
        `INSERT INTO users (
           id,
           email,
           phone,
           password_hash,
           email_verified,
           email_verified_at,
           requested_role,
           created_at,
           updated_at
         )
         VALUES (
           $1::uuid,
           $2::varchar(320),
           $3::varchar(32),
           $4::text,
           $5::boolean,
           CASE WHEN $5::boolean THEN $6::timestamptz ELSE NULL::timestamptz END,
           $7::varchar(16),
           $6::timestamptz,
           $6::timestamptz
         )
         RETURNING id, email, phone, password_hash, email_verified, created_at, updated_at`,
        [
          input.id,
          input.email,
          input.phone,
          input.passwordHash,
          input.emailVerified,
          input.now,
          input.requestedRole,
        ],
      );
      const row = result.rows[0];

      if (row === undefined) {
        throw new Error('PostgreSQL did not return the created user.');
      }

      if (input.requestedRole === 'trainer') {
        const requestResult = await client.query<TrainerVerificationRequestIdentityRow>(
          `INSERT INTO trainer_verification_requests (
             user_id, status, submitted_at, created_at, updated_at
           )
           VALUES ($1::uuid, 'pending', NULL, $2::timestamptz, $2::timestamptz)
           RETURNING id`,
          [input.id, input.now],
        );
        const verificationRequest = requestResult.rows[0];

        if (verificationRequest === undefined) {
          throw new Error('PostgreSQL did not return the trainer-verification request.');
        }

        await client.query(
          `INSERT INTO trainer_verification_events (
             request_id,
             actor_user_id,
             from_status,
             to_status,
             reason,
             created_at
           )
           VALUES ($1::uuid, $2::uuid, NULL, 'pending', 'trainer_role_selected', $3::timestamptz)`,
          [verificationRequest.id, input.id, input.now],
        );
      }

      await client.query('COMMIT');
      return { status: 'created', user: mapUser(row) };
    } catch (error) {
      await this.rollbackQuietly(client);

      if (
        !isUniqueViolation(error) ||
        (!error.constraint?.includes('email') && !error.constraint?.includes('phone'))
      ) {
        throw error;
      }

      const constraint = error.constraint ?? '';
      return {
        status: 'conflict',
        field: constraint.includes('phone') ? 'phone' : 'email',
      };
    } finally {
      client.release();
    }
  }

  public async createRefreshSession(input: RefreshSessionInput): Promise<void> {
    await this.pool.query(
      `INSERT INTO refresh_tokens (id, user_id, token_hash, expires_at, created_at)
       VALUES ($1, $2, $3, $4, $5)`,
      [input.id, input.userId, input.tokenHash, input.expiresAt, input.now],
    );
  }

  public async rotateRefreshSession(
    input: RotateRefreshSessionInput,
  ): Promise<RotateRefreshSessionResult> {
    const client = await this.pool.connect();

    try {
      await client.query('BEGIN');
      const ownerResult = await client.query<RefreshSessionOwnerRow>(
        `SELECT user_id
         FROM refresh_tokens
         WHERE token_hash = $1`,
        [input.currentTokenHash],
      );
      const owner = ownerResult.rows[0];

      if (owner === undefined) {
        await client.query('COMMIT');
        return { status: 'invalid' };
      }

      // Every refresh rotation/revocation locks the owning user first, matching
      // password reset and account deletion lock order.
      const userResult = await client.query<UserRow>(
        `SELECT id, email, phone, password_hash, email_verified, created_at, updated_at
         FROM users
         WHERE id = $1
         FOR UPDATE`,
        [owner.user_id],
      );
      const user = userResult.rows[0];

      if (user === undefined) {
        await client.query('COMMIT');
        return { status: 'invalid' };
      }

      await this.hooks.afterUserLocked?.('rotate', owner.user_id);
      const result = await client.query<RotationRow>(
        `SELECT
           rt.id AS refresh_id,
           rt.user_id AS refresh_user_id,
           rt.expires_at AS refresh_expires_at,
           rt.revoked_at AS refresh_revoked_at,
           rt.replaced_by_token_id AS refresh_replaced_by_token_id
         FROM refresh_tokens rt
         WHERE rt.token_hash = $1 AND rt.user_id = $2
         FOR UPDATE`,
        [input.currentTokenHash, owner.user_id],
      );
      const row = result.rows[0];

      if (row === undefined) {
        await client.query('COMMIT');
        return { status: 'invalid' };
      }

      if (row.refresh_revoked_at !== null) {
        if (row.refresh_replaced_by_token_id !== null) {
          await client.query(
            `UPDATE refresh_tokens
             SET revoked_at = COALESCE(revoked_at, $2)
             WHERE user_id = $1 AND revoked_at IS NULL`,
            [row.refresh_user_id, input.now],
          );
        }
        await client.query('COMMIT');
        return row.refresh_replaced_by_token_id === null
          ? { status: 'invalid' }
          : { status: 'reused' };
      }

      if (asDate(row.refresh_expires_at).getTime() <= input.now.getTime()) {
        await client.query('UPDATE refresh_tokens SET revoked_at = $2 WHERE id = $1', [
          row.refresh_id,
          input.now,
        ]);
        await client.query('COMMIT');
        return { status: 'invalid' };
      }

      await client.query(
        `INSERT INTO refresh_tokens (id, user_id, token_hash, expires_at, created_at)
         VALUES ($1, $2, $3, $4, $5)`,
        [
          input.replacement.id,
          row.refresh_user_id,
          input.replacement.tokenHash,
          input.replacement.expiresAt,
          input.replacement.now,
        ],
      );
      await client.query(
        `UPDATE refresh_tokens
         SET revoked_at = $2, replaced_by_token_id = $3
         WHERE id = $1`,
        [row.refresh_id, input.now, input.replacement.id],
      );
      await client.query('COMMIT');
      return { status: 'rotated', user: mapUser(user) };
    } catch (error) {
      await this.rollbackQuietly(client);
      throw error;
    } finally {
      client.release();
    }
  }

  public async revokeRefreshSessionInFamily(
    input: RevokeRefreshSessionInFamilyInput,
  ): Promise<boolean> {
    const client = await this.pool.connect();

    try {
      await client.query('BEGIN');
      const ownerResult = await client.query<RefreshSessionOwnerRow>(
        `SELECT user_id
         FROM refresh_tokens
         WHERE token_hash = $1`,
        [input.currentTokenHash],
      );
      const owner = ownerResult.rows[0];

      if (owner === undefined || owner.user_id !== input.expectedUserId) {
        await client.query('COMMIT');
        return false;
      }

      // Keep the global auth lock order user -> refresh sessions. Once held,
      // no concurrent rotation can extend this user's chain during traversal.
      const userLock = await client.query(
        `SELECT id
         FROM users
         WHERE id = $1
         FOR UPDATE`,
        [input.expectedUserId],
      );

      if (userLock.rowCount !== 1) {
        await client.query('COMMIT');
        return false;
      }

      await this.hooks.afterUserLocked?.('logout', input.expectedUserId);
      const currentResult = await client.query<RefreshSessionIdentityRow>(
        `SELECT id, user_id
         FROM refresh_tokens
         WHERE token_hash = $1 AND user_id = $2
         FOR UPDATE`,
        [input.currentTokenHash, input.expectedUserId],
      );
      const current = currentResult.rows[0];

      if (current === undefined || current.user_id !== input.expectedUserId) {
        await client.query('COMMIT');
        return false;
      }

      const result = await client.query(
        `WITH RECURSIVE
         proof_family (id, replaced_by_token_id) AS (
           SELECT id, replaced_by_token_id
           FROM refresh_tokens
           WHERE id = $1::uuid AND user_id = $2::uuid

           UNION

           SELECT child.id, child.replaced_by_token_id
           FROM proof_family AS parent
           JOIN refresh_tokens AS child ON child.id = parent.replaced_by_token_id
           WHERE child.user_id = $2::uuid
         ),
         target_family (id, replaced_by_token_id) AS (
           SELECT id, replaced_by_token_id
           FROM refresh_tokens
           WHERE id = $3::uuid AND user_id = $2::uuid

           UNION

           SELECT child.id, child.replaced_by_token_id
           FROM target_family AS parent
           JOIN refresh_tokens AS child ON child.id = parent.replaced_by_token_id
           WHERE child.user_id = $2::uuid
         )
         UPDATE refresh_tokens AS target_session
         SET revoked_at = COALESCE(target_session.revoked_at, $4)
         WHERE target_session.user_id = $2::uuid
           AND target_session.id IN (SELECT id FROM target_family)
           AND EXISTS (
             SELECT 1
             FROM proof_family
             WHERE proof_family.id = $3::uuid
           )
         RETURNING target_session.id`,
        [input.ancestorSessionId, input.expectedUserId, current.id, input.now],
      );
      await client.query('COMMIT');
      return (result.rowCount ?? 0) > 0;
    } catch (error) {
      await this.rollbackQuietly(client);
      throw error;
    } finally {
      client.release();
    }
  }

  public async revokeAllRefreshSessions(userId: string, now: Date): Promise<void> {
    const client = await this.pool.connect();

    try {
      await client.query('BEGIN');
      await client.query('SELECT id FROM users WHERE id = $1 FOR UPDATE', [userId]);
      await client.query(
        `UPDATE refresh_tokens
         SET revoked_at = COALESCE(revoked_at, $2)
         WHERE user_id = $1 AND revoked_at IS NULL`,
        [userId, now],
      );
      await client.query('COMMIT');
    } catch (error) {
      await this.rollbackQuietly(client);
      throw error;
    } finally {
      client.release();
    }
  }

  public async storePasswordResetToken(input: OneTimeTokenInput): Promise<void> {
    const client = await this.pool.connect();

    try {
      await client.query('BEGIN');
      await client.query('SELECT id FROM users WHERE id = $1 FOR UPDATE', [input.userId]);
      await client.query(
        `UPDATE password_reset_tokens
         SET used_at = COALESCE(used_at, $2)
         WHERE user_id = $1 AND used_at IS NULL`,
        [input.userId, input.now],
      );
      await client.query(
        `INSERT INTO password_reset_tokens (
           id, user_id, token_hash, expires_at, created_at
         )
         VALUES ($1, $2, $3, $4, $5)`,
        [input.id, input.userId, input.tokenHash, input.expiresAt, input.now],
      );
      await client.query('COMMIT');
    } catch (error) {
      await this.rollbackQuietly(client);
      throw error;
    } finally {
      client.release();
    }
  }

  public async replacePasswordUsingResetToken(
    tokenHash: string,
    newPasswordHash: string,
    now: Date,
  ): Promise<UserRecord | null> {
    const client = await this.pool.connect();

    try {
      await client.query('BEGIN');
      const ownerResult = await client.query<OneTimeTokenOwnerRow>(
        `SELECT user_id
         FROM password_reset_tokens
         WHERE token_hash = $1`,
        [tokenHash],
      );
      const owner = ownerResult.rows[0];

      if (owner === undefined) {
        await client.query('COMMIT');
        return null;
      }

      await client.query('SELECT id FROM users WHERE id = $1 FOR UPDATE', [owner.user_id]);
      const tokenResult = await client.query<OneTimeTokenRow>(
        `SELECT id, user_id, expires_at, used_at
         FROM password_reset_tokens
         WHERE token_hash = $1
         FOR UPDATE`,
        [tokenHash],
      );
      const token = tokenResult.rows[0];

      if (
        token === undefined ||
        token.used_at !== null ||
        asDate(token.expires_at).getTime() <= now.getTime()
      ) {
        await client.query('COMMIT');
        return null;
      }

      const userResult = await client.query<UserRow>(
        `UPDATE users
         SET password_hash = $2, updated_at = $3
         WHERE id = $1
         RETURNING id, email, phone, password_hash, email_verified, created_at, updated_at`,
        [token.user_id, newPasswordHash, now],
      );
      await client.query(
        `UPDATE password_reset_tokens
         SET used_at = COALESCE(used_at, $2)
         WHERE user_id = $1 AND used_at IS NULL`,
        [token.user_id, now],
      );
      await client.query(
        `UPDATE refresh_tokens
         SET revoked_at = COALESCE(revoked_at, $2)
         WHERE user_id = $1 AND revoked_at IS NULL`,
        [token.user_id, now],
      );
      await client.query('COMMIT');
      const user = userResult.rows[0];
      return user === undefined ? null : mapUser(user);
    } catch (error) {
      await this.rollbackQuietly(client);
      throw error;
    } finally {
      client.release();
    }
  }

  public async storeEmailVerificationToken(input: OneTimeTokenInput): Promise<void> {
    const client = await this.pool.connect();

    try {
      await client.query('BEGIN');
      await client.query('SELECT id FROM users WHERE id = $1 FOR UPDATE', [input.userId]);
      await client.query(
        `UPDATE email_verification_tokens
         SET used_at = COALESCE(used_at, $2)
         WHERE user_id = $1 AND used_at IS NULL`,
        [input.userId, input.now],
      );
      await client.query(
        `INSERT INTO email_verification_tokens (
           id, user_id, token_hash, expires_at, created_at
         )
         VALUES ($1, $2, $3, $4, $5)`,
        [input.id, input.userId, input.tokenHash, input.expiresAt, input.now],
      );
      await client.query('COMMIT');
    } catch (error) {
      await this.rollbackQuietly(client);
      throw error;
    } finally {
      client.release();
    }
  }

  public async verifyEmailUsingToken(tokenHash: string, now: Date): Promise<UserRecord | null> {
    const client = await this.pool.connect();

    try {
      await client.query('BEGIN');
      const ownerResult = await client.query<OneTimeTokenOwnerRow>(
        `SELECT user_id
         FROM email_verification_tokens
         WHERE token_hash = $1`,
        [tokenHash],
      );
      const owner = ownerResult.rows[0];

      if (owner === undefined) {
        await client.query('COMMIT');
        return null;
      }

      await client.query('SELECT id FROM users WHERE id = $1 FOR UPDATE', [owner.user_id]);
      const tokenResult = await client.query<OneTimeTokenRow>(
        `SELECT id, user_id, expires_at, used_at
         FROM email_verification_tokens
         WHERE token_hash = $1
         FOR UPDATE`,
        [tokenHash],
      );
      const token = tokenResult.rows[0];

      if (
        token === undefined ||
        token.used_at !== null ||
        asDate(token.expires_at).getTime() <= now.getTime()
      ) {
        await client.query('COMMIT');
        return null;
      }

      const userResult = await client.query<UserRow>(
        `UPDATE users
         SET email_verified = true, email_verified_at = $2, updated_at = $2
         WHERE id = $1
         RETURNING id, email, phone, password_hash, email_verified, created_at, updated_at`,
        [token.user_id, now],
      );
      await client.query(
        `UPDATE email_verification_tokens
         SET used_at = COALESCE(used_at, $2)
         WHERE user_id = $1 AND used_at IS NULL`,
        [token.user_id, now],
      );
      await client.query('COMMIT');
      const user = userResult.rows[0];
      return user === undefined ? null : mapUser(user);
    } catch (error) {
      await this.rollbackQuietly(client);
      throw error;
    } finally {
      client.release();
    }
  }

  private async rollbackQuietly(client: PoolClient): Promise<void> {
    try {
      await client.query('ROLLBACK');
    } catch {
      console.error('Failed to roll back PostgreSQL transaction.');
    }
  }
}
