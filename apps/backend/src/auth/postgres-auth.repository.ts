import type { Pool, PoolClient, QueryResultRow } from 'pg';

import type {
  AuthRepository,
  CreateUserInput,
  CreateUserResult,
  OneTimeTokenInput,
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

interface RotationRow extends QueryResultRow {
  refresh_id: string;
  refresh_user_id: string;
  refresh_expires_at: Date | string;
  refresh_revoked_at: Date | string | null;
  user_id: string;
  user_email: string | null;
  user_phone: string | null;
  user_password_hash: string;
  user_email_verified: boolean;
  user_created_at: Date | string;
  user_updated_at: Date | string;
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

const mapRotationUser = (row: RotationRow): UserRecord => ({
  id: row.user_id,
  email: row.user_email,
  phone: row.user_phone,
  passwordHash: row.user_password_hash,
  emailVerified: row.user_email_verified,
  createdAt: asDate(row.user_created_at),
  updatedAt: asDate(row.user_updated_at),
});

const isUniqueViolation = (error: unknown): error is { code: string; constraint?: string } =>
  typeof error === 'object' &&
  error !== null &&
  'code' in error &&
  (error as { code?: unknown }).code === '23505';

export class PostgresAuthRepository implements AuthRepository {
  public constructor(private readonly pool: Pool) {}

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
    try {
      const result = await this.pool.query<UserRow>(
        `INSERT INTO users (
           id, email, phone, password_hash, email_verified, email_verified_at, created_at, updated_at
         )
         VALUES ($1, $2, $3, $4, $5, CASE WHEN $5 THEN $6 ELSE NULL END, $6, $6)
         RETURNING id, email, phone, password_hash, email_verified, created_at, updated_at`,
        [
          input.id,
          input.email,
          input.phone,
          input.passwordHash,
          input.emailVerified,
          input.now,
        ],
      );
      const row = result.rows[0];

      if (row === undefined) {
        throw new Error('PostgreSQL did not return the created user.');
      }

      return { status: 'created', user: mapUser(row) };
    } catch (error) {
      if (!isUniqueViolation(error)) {
        throw error;
      }

      const constraint = error.constraint ?? '';
      return {
        status: 'conflict',
        field: constraint.includes('phone') ? 'phone' : 'email',
      };
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
      const result = await client.query<RotationRow>(
        `SELECT
           rt.id AS refresh_id,
           rt.user_id AS refresh_user_id,
           rt.expires_at AS refresh_expires_at,
           rt.revoked_at AS refresh_revoked_at,
           u.id AS user_id,
           u.email AS user_email,
           u.phone AS user_phone,
           u.password_hash AS user_password_hash,
           u.email_verified AS user_email_verified,
           u.created_at AS user_created_at,
           u.updated_at AS user_updated_at
         FROM refresh_tokens rt
         JOIN users u ON u.id = rt.user_id
         WHERE rt.token_hash = $1
         FOR UPDATE OF rt`,
        [input.currentTokenHash],
      );
      const row = result.rows[0];

      if (row === undefined) {
        await client.query('COMMIT');
        return { status: 'invalid' };
      }

      if (row.refresh_revoked_at !== null) {
        await client.query(
          `UPDATE refresh_tokens
           SET revoked_at = COALESCE(revoked_at, $2)
           WHERE user_id = $1 AND revoked_at IS NULL`,
          [row.refresh_user_id, input.now],
        );
        await client.query('COMMIT');
        return { status: 'reused' };
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
      return { status: 'rotated', user: mapRotationUser(row) };
    } catch (error) {
      await this.rollbackQuietly(client);
      throw error;
    } finally {
      client.release();
    }
  }

  public async revokeRefreshSessionByHash(tokenHash: string, now: Date): Promise<void> {
    await this.pool.query(
      `UPDATE refresh_tokens
       SET revoked_at = COALESCE(revoked_at, $2)
       WHERE token_hash = $1`,
      [tokenHash, now],
    );
  }

  public async revokeAllRefreshSessions(userId: string, now: Date): Promise<void> {
    await this.pool.query(
      `UPDATE refresh_tokens
       SET revoked_at = COALESCE(revoked_at, $2)
       WHERE user_id = $1 AND revoked_at IS NULL`,
      [userId, now],
    );
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
    } catch (rollbackError) {
      console.error('Failed to roll back PostgreSQL transaction.', rollbackError);
    }
  }
}
