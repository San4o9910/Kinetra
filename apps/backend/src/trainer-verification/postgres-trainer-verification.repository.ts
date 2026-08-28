import type {
  RequestedRole,
  TrainerVerificationMaterialKind,
  TrainerVerificationStatus,
} from '@kinetra/shared';
import type { Pool, PoolClient, QueryResultRow } from 'pg';

import type {
  ReviewerMutationResult,
  TrainerVerificationApplicationInputRecord,
  TrainerVerificationListResult,
  TrainerVerificationMaterialSnapshot,
  TrainerVerificationRepository,
  TrainerVerificationRequestSnapshot,
  TrainerVerificationReviewAction,
  TrainerVerificationReviewResult,
  TrainerVerificationUserMutationResult,
  TrainerVerificationUserSnapshot,
} from './repository.js';

interface UserRoleRow extends QueryResultRow {
  readonly requested_role: RequestedRole;
  readonly has_active_trainer_profile: boolean;
}

interface RequestRow extends QueryResultRow {
  readonly id: string;
  readonly user_id: string;
  readonly status: TrainerVerificationStatus;
  readonly display_name: string | null;
  readonly specialization: string | null;
  readonly experience_years: number | null;
  readonly bio: string | null;
  readonly city: string | null;
  readonly timezone: string | null;
  readonly submitted_at: Date | string | null;
  readonly reviewed_at: Date | string | null;
  readonly reviewer_user_id: string | null;
  readonly review_reason: string | null;
  readonly created_at: Date | string;
  readonly updated_at: Date | string;
}

interface MaterialRow extends QueryResultRow {
  readonly id: string;
  readonly request_id: string;
  readonly kind: TrainerVerificationMaterialKind;
  readonly url: string;
  readonly title: string;
  readonly issued_at: Date | string | null;
  readonly expires_at: Date | string | null;
  readonly created_at: Date | string;
}

interface RequestOwnerRow extends QueryResultRow {
  readonly user_id: string;
}

interface LockedApplicantRow extends QueryResultRow {
  readonly id: string;
  readonly email_verified: boolean;
  readonly requested_role: RequestedRole;
}

const asDate = (value: Date | string): Date =>
  value instanceof Date ? new Date(value.getTime()) : new Date(value);

const asCalendarDate = (value: Date | string | null): string | null => {
  if (value === null) return null;
  if (typeof value === 'string') return value.slice(0, 10);
  return value.toISOString().slice(0, 10);
};

const requestSelect = `
  SELECT
    id, user_id, status, display_name, specialization, experience_years,
    bio, city, timezone, submitted_at, reviewed_at, reviewer_user_id,
    review_reason, created_at, updated_at
  FROM trainer_verification_requests
`;

const isUniqueViolation = (error: unknown): boolean =>
  typeof error === 'object' &&
  error !== null &&
  'code' in error &&
  (error as { readonly code?: unknown }).code === '23505';

export class PostgresTrainerVerificationRepository implements TrainerVerificationRepository {
  public constructor(private readonly pool: Pool) {}

  public async findForUser(userId: string): Promise<TrainerVerificationUserSnapshot | null> {
    const client = await this.pool.connect();

    try {
      await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ');
      const user = await client.query<UserRoleRow>(
        `SELECT
           user_record.requested_role,
           EXISTS (
             SELECT 1
             FROM trainer_profiles AS profile
             WHERE profile.user_id = user_record.id
               AND profile.is_active = true
           ) AS has_active_trainer_profile
         FROM users AS user_record
         WHERE user_record.id = $1`,
        [userId],
      );
      const role = user.rows[0];

      if (role === undefined) {
        await client.query('COMMIT');
        return null;
      }

      const value = {
        requestedRole: role.requested_role,
        hasActiveTrainerProfile: role.has_active_trainer_profile,
        request: await this.loadLatestRequest(client, userId),
      };
      await client.query('COMMIT');
      return value;
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  public async submit(
    userId: string,
    input: TrainerVerificationApplicationInputRecord,
    now: Date,
  ): Promise<TrainerVerificationUserMutationResult> {
    const client = await this.pool.connect();

    try {
      await client.query('BEGIN');
      const role = await this.lockUserRole(client, userId);

      if (role === null) {
        await client.query('ROLLBACK');
        return { status: 'user_not_found' };
      }

      if (role !== 'trainer') {
        await client.query('ROLLBACK');
        return { status: 'role_not_trainer' };
      }

      const latest = await this.lockLatestRequest(client, userId);
      let requestId: string;
      let eventFromStatus: TrainerVerificationStatus | null = null;

      if (latest === null) {
        const inserted = await client.query<{ readonly id: string }>(
          `INSERT INTO trainer_verification_requests (
             user_id, status, display_name, specialization, experience_years,
             bio, city, timezone, submitted_at, created_at, updated_at
           ) VALUES ($1, 'pending', $2, $3, $4, $5, $6, $7, $8, $8, $8)
           RETURNING id`,
          [
            userId,
            input.displayName,
            input.specialization,
            input.experienceYears,
            input.bio,
            input.city,
            input.timezone,
            now,
          ],
        );
        const row = inserted.rows[0];
        if (row === undefined) throw new Error('PostgreSQL did not return the created request.');
        requestId = row.id;
      } else if (latest.status === 'pending' && latest.submitted_at === null) {
        await client.query(
          `UPDATE trainer_verification_requests
           SET display_name = $2,
               specialization = $3,
               experience_years = $4,
               bio = $5,
               city = $6,
               timezone = $7,
               submitted_at = $8,
               updated_at = $8
           WHERE id = $1`,
          [
            latest.id,
            input.displayName,
            input.specialization,
            input.experienceYears,
            input.bio,
            input.city,
            input.timezone,
            now,
          ],
        );
        requestId = latest.id;
        eventFromStatus = 'pending';
      } else if (latest.status === 'rejected' || latest.status === 'withdrawn') {
        const inserted = await client.query<{ readonly id: string }>(
          `INSERT INTO trainer_verification_requests (
             user_id, status, display_name, specialization, experience_years,
             bio, city, timezone, submitted_at, created_at, updated_at
           ) VALUES ($1, 'pending', $2, $3, $4, $5, $6, $7, $8, $8, $8)
           RETURNING id`,
          [
            userId,
            input.displayName,
            input.specialization,
            input.experienceYears,
            input.bio,
            input.city,
            input.timezone,
            now,
          ],
        );
        const row = inserted.rows[0];
        if (row === undefined) throw new Error('PostgreSQL did not return the created request.');
        requestId = row.id;
      } else {
        await client.query('ROLLBACK');
        return { status: 'invalid_state' };
      }

      await this.replaceMaterials(client, requestId, input, now);
      await this.appendEvent(
        client,
        requestId,
        userId,
        eventFromStatus,
        'pending',
        'application_submitted',
        now,
      );
      const value = await this.loadUserSnapshot(client, userId);

      if (value === null) throw new Error('The request owner disappeared during submission.');
      await client.query('COMMIT');
      return { status: 'ok', value };
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      if (isUniqueViolation(error)) return { status: 'conflict' };
      throw error;
    } finally {
      client.release();
    }
  }

  public async update(
    userId: string,
    input: TrainerVerificationApplicationInputRecord,
    now: Date,
  ): Promise<TrainerVerificationUserMutationResult> {
    const client = await this.pool.connect();

    try {
      await client.query('BEGIN');
      const role = await this.lockUserRole(client, userId);

      if (role === null) {
        await client.query('ROLLBACK');
        return { status: 'user_not_found' };
      }
      if (role !== 'trainer') {
        await client.query('ROLLBACK');
        return { status: 'role_not_trainer' };
      }

      const request = await this.lockLatestRequest(client, userId);
      if (request === null) {
        await client.query('ROLLBACK');
        return { status: 'request_not_found' };
      }

      if (request.status !== 'needs_more_info') {
        await client.query('ROLLBACK');
        return { status: 'invalid_state' };
      }

      await client.query(
        `UPDATE trainer_verification_requests
         SET status = 'pending',
             display_name = $2,
             specialization = $3,
             experience_years = $4,
             bio = $5,
             city = $6,
             timezone = $7,
             submitted_at = $8,
             reviewed_at = NULL,
             reviewer_user_id = NULL,
             review_reason = NULL,
             updated_at = $8
         WHERE id = $1`,
        [
          request.id,
          input.displayName,
          input.specialization,
          input.experienceYears,
          input.bio,
          input.city,
          input.timezone,
          now,
        ],
      );
      await this.replaceMaterials(client, request.id, input, now);
      await this.appendEvent(
        client,
        request.id,
        userId,
        'needs_more_info',
        'pending',
        'application_resubmitted',
        now,
      );
      const value = await this.loadUserSnapshot(client, userId);
      if (value === null) throw new Error('The request owner disappeared during update.');
      await client.query('COMMIT');
      return { status: 'ok', value };
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  public async withdraw(userId: string, now: Date): Promise<TrainerVerificationUserMutationResult> {
    const client = await this.pool.connect();

    try {
      await client.query('BEGIN');
      const role = await this.lockUserRole(client, userId);

      if (role === null) {
        await client.query('ROLLBACK');
        return { status: 'user_not_found' };
      }
      if (role !== 'trainer') {
        await client.query('ROLLBACK');
        return { status: 'role_not_trainer' };
      }

      const request = await this.lockLatestRequest(client, userId);
      if (request === null) {
        await client.query('ROLLBACK');
        return { status: 'request_not_found' };
      }

      if (
        request.submitted_at === null ||
        (request.status !== 'pending' && request.status !== 'needs_more_info')
      ) {
        await client.query('ROLLBACK');
        return { status: 'invalid_state' };
      }

      await client.query(
        `UPDATE trainer_verification_requests
         SET status = 'withdrawn',
             reviewed_at = NULL,
             reviewer_user_id = NULL,
             review_reason = NULL,
             updated_at = $2
         WHERE id = $1`,
        [request.id, now],
      );
      await this.appendEvent(
        client,
        request.id,
        userId,
        request.status,
        'withdrawn',
        'application_withdrawn',
        now,
      );
      const value = await this.loadUserSnapshot(client, userId);
      if (value === null) throw new Error('The request owner disappeared during withdrawal.');
      await client.query('COMMIT');
      return { status: 'ok', value };
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  public async listForReviewer(
    reviewerUserId: string,
    status: TrainerVerificationStatus | null,
  ): Promise<TrainerVerificationListResult> {
    const client = await this.pool.connect();

    try {
      await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ');
      if (!(await this.isReviewer(client, reviewerUserId, true))) {
        await client.query('ROLLBACK');
        return { status: 'not_reviewer' };
      }

      const result = await client.query<RequestRow>(
        `${requestSelect}
         WHERE submitted_at IS NOT NULL
           AND ($1::varchar IS NULL OR status = $1)
         ORDER BY created_at DESC, id DESC
         LIMIT 100`,
        [status],
      );
      const requests = await this.hydrateRequests(client, result.rows);
      await client.query('COMMIT');
      return { status: 'ok', requests };
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  public async review(
    reviewerUserId: string,
    requestId: string,
    action: TrainerVerificationReviewAction,
    reason: string | null,
    now: Date,
  ): Promise<TrainerVerificationReviewResult> {
    const client = await this.pool.connect();

    try {
      await client.query('BEGIN');
      if (!(await this.isReviewer(client, reviewerUserId, true))) {
        await client.query('ROLLBACK');
        return { status: 'not_reviewer' };
      }

      const ownerResult = await client.query<RequestOwnerRow>(
        'SELECT user_id FROM trainer_verification_requests WHERE id = $1',
        [requestId],
      );
      const owner = ownerResult.rows[0];
      if (owner === undefined) {
        await client.query('ROLLBACK');
        return { status: 'request_not_found' };
      }
      if (owner.user_id === reviewerUserId) {
        await client.query('ROLLBACK');
        return { status: 'self_review' };
      }

      if (action === 'approve') {
        // Match the trusted chat trainer lifecycle lock order before touching
        // a trainer profile: global trainer-admin lock -> applicant user.
        await this.lockTrainerAdministration(client);
        const applicantResult = await client.query<LockedApplicantRow>(
          'SELECT id, email_verified, requested_role FROM users WHERE id = $1 FOR UPDATE',
          [owner.user_id],
        );
        const applicant = applicantResult.rows[0];
        if (applicant === undefined) {
          await client.query('ROLLBACK');
          return { status: 'request_not_found' };
        }
        if (applicant.requested_role !== 'trainer') {
          await client.query('ROLLBACK');
          return { status: 'invalid_state' };
        }
        if (!applicant.email_verified) {
          await client.query('ROLLBACK');
          return { status: 'email_not_verified' };
        }
      }

      const result = await client.query<RequestRow>(`${requestSelect} WHERE id = $1 FOR UPDATE`, [
        requestId,
      ]);
      const request = result.rows[0];

      if (request === undefined) {
        await client.query('ROLLBACK');
        return { status: 'request_not_found' };
      }
      if (request.user_id === reviewerUserId) {
        await client.query('ROLLBACK');
        return { status: 'self_review' };
      }
      if (request.submitted_at === null) {
        await client.query('ROLLBACK');
        return { status: 'not_submitted' };
      }

      if (action === 'approve' && request.status === 'approved') {
        const approved = await this.loadRequest(client, request.id);
        if (approved === null) throw new Error('Approved request disappeared.');
        await client.query('COMMIT');
        return { status: 'ok', request: approved };
      }

      if (request.status !== 'pending') {
        await client.query('ROLLBACK');
        return { status: 'invalid_state' };
      }

      if (action === 'approve') {
        const history = await client.query(
          'SELECT 1 FROM chat_conversations WHERE client_user_id = $1 LIMIT 1 FOR UPDATE',
          [request.user_id],
        );
        if (history.rowCount !== 0) {
          await client.query('ROLLBACK');
          return { status: 'client_chat_history' };
        }

        await this.ensureTrainerProfile(client, request, now);
        await client.query(
          `UPDATE trainer_verification_requests
           SET status = 'approved',
               reviewed_at = $2,
               reviewer_user_id = $3,
               review_reason = $4,
               updated_at = $2
           WHERE id = $1`,
          [request.id, now, reviewerUserId, reason],
        );
        await this.appendEvent(
          client,
          request.id,
          reviewerUserId,
          'pending',
          'approved',
          reason,
          now,
        );
      } else {
        const nextStatus = action === 'request_info' ? 'needs_more_info' : 'rejected';
        await client.query(
          `UPDATE trainer_verification_requests
           SET status = $2,
               reviewed_at = $3,
               reviewer_user_id = $4,
               review_reason = $5,
               updated_at = $3
           WHERE id = $1`,
          [request.id, nextStatus, now, reviewerUserId, reason],
        );
        await this.appendEvent(
          client,
          request.id,
          reviewerUserId,
          'pending',
          nextStatus,
          reason,
          now,
        );
      }

      const reviewed = await this.loadRequest(client, request.id);
      if (reviewed === null) throw new Error('Reviewed request disappeared.');
      await client.query('COMMIT');
      return { status: 'ok', request: reviewed };
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  public async grantReviewer(userId: string, now: Date): Promise<ReviewerMutationResult> {
    const result = await this.pool.query(
      `INSERT INTO trainer_verification_reviewers (user_id, granted_at, updated_at)
       SELECT id, $2, $2 FROM users WHERE id = $1
       ON CONFLICT (user_id) DO UPDATE SET updated_at = EXCLUDED.updated_at
       RETURNING user_id`,
      [userId, now],
    );
    return result.rowCount === 1 ? 'updated' : 'user_not_found';
  }

  public async revokeReviewer(userId: string): Promise<ReviewerMutationResult> {
    const result = await this.pool.query(
      'DELETE FROM trainer_verification_reviewers WHERE user_id = $1',
      [userId],
    );
    return result.rowCount === 1 ? 'updated' : 'user_not_found';
  }

  private async lockUserRole(client: PoolClient, userId: string): Promise<RequestedRole | null> {
    const result = await client.query<UserRoleRow>(
      'SELECT requested_role FROM users WHERE id = $1 FOR UPDATE',
      [userId],
    );
    return result.rows[0]?.requested_role ?? null;
  }

  private async lockLatestRequest(client: PoolClient, userId: string): Promise<RequestRow | null> {
    const result = await client.query<RequestRow>(
      `${requestSelect}
       WHERE user_id = $1
       ORDER BY
         (status IN ('pending', 'needs_more_info', 'approved')) DESC,
         created_at DESC,
         updated_at DESC,
         id DESC
       LIMIT 1
       FOR UPDATE`,
      [userId],
    );
    return result.rows[0] ?? null;
  }

  private async lockTrainerAdministration(client: PoolClient): Promise<void> {
    await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [
      'kinetra:chat:trainer-administration:v1',
    ]);
  }

  private async isReviewer(client: PoolClient, userId: string, lock = false): Promise<boolean> {
    const result = await client.query(
      `SELECT user_id
       FROM trainer_verification_reviewers
       WHERE user_id = $1
       ${lock ? 'FOR KEY SHARE' : ''}`,
      [userId],
    );
    return result.rowCount === 1;
  }

  private async replaceMaterials(
    client: PoolClient,
    requestId: string,
    input: TrainerVerificationApplicationInputRecord,
    now: Date,
  ): Promise<void> {
    await client.query('DELETE FROM trainer_verification_documents WHERE request_id = $1', [
      requestId,
    ]);
    for (const material of input.materials) {
      await client.query(
        `INSERT INTO trainer_verification_documents (
           request_id, kind, url, title, issued_at, expires_at, created_at
         ) VALUES ($1, $2, $3, $4, $5::date, $6::date, $7)`,
        [
          requestId,
          material.kind,
          material.url,
          material.title,
          material.issuedAt,
          material.expiresAt,
          now,
        ],
      );
    }
  }

  private async appendEvent(
    client: PoolClient,
    requestId: string,
    actorUserId: string | null,
    fromStatus: TrainerVerificationStatus | null,
    toStatus: TrainerVerificationStatus,
    reason: string | null,
    now: Date,
  ): Promise<void> {
    await client.query(
      `INSERT INTO trainer_verification_events (
         request_id, actor_user_id, from_status, to_status, reason, created_at
       ) VALUES ($1, $2, $3, $4, $5, $6)`,
      [requestId, actorUserId, fromStatus, toStatus, reason, now],
    );
  }

  private async ensureTrainerProfile(
    client: PoolClient,
    request: RequestRow,
    now: Date,
  ): Promise<void> {
    if (request.display_name === null) {
      throw new Error('Submitted trainer verification request has no display name.');
    }

    await client.query(
      `INSERT INTO trainer_profiles (
         user_id, display_name, is_active, is_default, can_manage_videos, created_at, updated_at
       ) VALUES ($1, $2, true, false, false, $3, $3)
       ON CONFLICT (user_id) DO UPDATE
       SET display_name = EXCLUDED.display_name,
           is_active = true,
           updated_at = EXCLUDED.updated_at`,
      [request.user_id, request.display_name, now],
    );
  }

  private async loadUserSnapshot(
    client: PoolClient,
    userId: string,
  ): Promise<TrainerVerificationUserSnapshot | null> {
    const role = await client.query<UserRoleRow>(
      `SELECT
         user_record.requested_role,
         EXISTS (
           SELECT 1
           FROM trainer_profiles AS profile
           WHERE profile.user_id = user_record.id
             AND profile.is_active = true
         ) AS has_active_trainer_profile
       FROM users AS user_record
       WHERE user_record.id = $1`,
      [userId],
    );
    const row = role.rows[0];
    if (row === undefined) return null;
    return {
      requestedRole: row.requested_role,
      hasActiveTrainerProfile: row.has_active_trainer_profile,
      request: await this.loadLatestRequest(client, userId),
    };
  }

  private async loadLatestRequest(
    client: PoolClient,
    userId: string,
  ): Promise<TrainerVerificationRequestSnapshot | null> {
    const result = await client.query<RequestRow>(
      `${requestSelect}
       WHERE user_id = $1
       ORDER BY
         (status IN ('pending', 'needs_more_info', 'approved')) DESC,
         created_at DESC,
         updated_at DESC,
         id DESC
       LIMIT 1`,
      [userId],
    );
    const row = result.rows[0];
    return row === undefined ? null : this.hydrateRequest(client, row);
  }

  private async loadRequest(
    client: PoolClient,
    requestId: string,
  ): Promise<TrainerVerificationRequestSnapshot | null> {
    const result = await client.query<RequestRow>(`${requestSelect} WHERE id = $1`, [requestId]);
    const row = result.rows[0];
    return row === undefined ? null : this.hydrateRequest(client, row);
  }

  private async hydrateRequest(
    client: PoolClient,
    row: RequestRow,
  ): Promise<TrainerVerificationRequestSnapshot> {
    const requests = await this.hydrateRequests(client, [row]);
    const request = requests[0];
    if (request === undefined) throw new Error('Could not hydrate trainer verification request.');
    return request;
  }

  private async hydrateRequests(
    client: PoolClient,
    rows: readonly RequestRow[],
  ): Promise<readonly TrainerVerificationRequestSnapshot[]> {
    if (rows.length === 0) return [];
    const materialsResult = await client.query<MaterialRow>(
      `SELECT id, request_id, kind, url, title, issued_at, expires_at, created_at
       FROM trainer_verification_documents
       WHERE request_id = ANY($1::uuid[])
       ORDER BY created_at, id`,
      [rows.map((row) => row.id)],
    );
    const materials = new Map<string, TrainerVerificationMaterialSnapshot[]>();

    for (const row of materialsResult.rows) {
      const list = materials.get(row.request_id) ?? [];
      list.push({
        id: row.id,
        kind: row.kind,
        url: row.url,
        title: row.title,
        issuedAt: asCalendarDate(row.issued_at),
        expiresAt: asCalendarDate(row.expires_at),
        createdAt: asDate(row.created_at),
      });
      materials.set(row.request_id, list);
    }

    return rows.map((row) => ({
      id: row.id,
      userId: row.user_id,
      status: row.status,
      displayName: row.display_name,
      specialization: row.specialization,
      experienceYears: row.experience_years,
      bio: row.bio,
      city: row.city,
      timezone: row.timezone,
      submittedAt: row.submitted_at === null ? null : asDate(row.submitted_at),
      reviewedAt: row.reviewed_at === null ? null : asDate(row.reviewed_at),
      reviewerUserId: row.reviewer_user_id,
      reviewReason: row.review_reason,
      createdAt: asDate(row.created_at),
      updatedAt: asDate(row.updated_at),
      materials: materials.get(row.id) ?? [],
    }));
  }
}
