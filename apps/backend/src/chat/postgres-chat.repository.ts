import { randomUUID } from 'node:crypto';
import type { Pool, PoolClient, QueryResultRow } from 'pg';

import { HttpError } from '../auth/errors.js';
import type {
  ChatActor,
  ChatConversationSnapshot,
  ChatMediaObjectLease,
  ChatMessageSnapshot,
  ChatParticipant,
  ChatPhotoSnapshot,
  ChatRepository,
  ChatRole,
  ConversationPage,
  CreateConversationResult,
  ListConversationsInput,
  ListMessagesInput,
  MediaDeletionBacklog,
  MediaDeletionJob,
  MessagePage,
  PhotoAccessSnapshot,
  ReadRepositoryInput,
  ReadRepositoryResult,
  ReadyPhotoInput,
  ReservePhotoInput,
  ReservePhotoResult,
  SendMessageRepositoryInput,
  SendMessageRepositoryResult,
  TrainerGrantInput,
  TrainerReassignInput,
} from './repository.js';

interface ActorRow extends QueryResultRow {
  readonly id: string;
  readonly email: string | null;
  readonly phone: string | null;
  readonly avatar_url: string | null;
  readonly username: string | null;
  readonly first_name: string | null;
  readonly onboarding_status: ChatActor['onboardingStatus'];
  readonly trainer_display_name: string | null;
}

interface ConversationRow extends QueryResultRow {
  readonly conversation_id: string;
  readonly client_user_id: string;
  readonly trainer_user_id: string;
  readonly last_message_sequence: string | number | null;
  readonly client_last_read_sequence: string | number;
  readonly trainer_last_read_sequence: string | number;
  readonly client_unread_count: number;
  readonly trainer_unread_count: number;
  readonly conversation_created_at: Date | string;
  readonly activity_at: Date | string;
  readonly client_display_name: string;
  readonly client_secondary_label: string;
  readonly client_avatar_url: string | null;
  readonly trainer_display_name: string;
  readonly trainer_avatar_url: string | null;
  readonly message_id: string | null;
  readonly message_sequence: string | number | null;
  readonly message_sender_user_id: string | null;
  readonly message_sender_role: 'client' | 'trainer' | null;
  readonly message_sender_name: string | null;
  readonly message_client_id: string | null;
  readonly message_fingerprint: string | null;
  readonly message_kind: 'text' | 'photo' | null;
  readonly message_body: string | null;
  readonly message_created_at: Date | string | null;
  readonly photo_id: string | null;
  readonly photo_conversation_id: string | null;
  readonly photo_uploader_user_id: string | null;
  readonly photo_client_upload_id: string | null;
  readonly photo_object_key: string | null;
  readonly photo_status: ChatPhotoSnapshot['status'] | null;
  readonly photo_mime_type: 'image/webp' | null;
  readonly photo_size_bytes: number | null;
  readonly photo_width: number | null;
  readonly photo_height: number | null;
  readonly photo_expires_at: Date | string | null;
  readonly photo_attempt_count: number | null;
  readonly photo_last_error_code: string | null;
  readonly photo_attached_at: Date | string | null;
}

interface MessageRow extends QueryResultRow {
  readonly id: string;
  readonly conversation_id: string;
  readonly sequence: string | number;
  readonly sender_user_id: string;
  readonly sender_role: 'client' | 'trainer';
  readonly sender_name_snapshot: string;
  readonly client_message_id: string;
  readonly request_fingerprint: string;
  readonly kind: 'text' | 'photo';
  readonly body: string | null;
  readonly created_at: Date | string;
  readonly photo_id: string | null;
  readonly photo_conversation_id: string | null;
  readonly photo_uploader_user_id: string | null;
  readonly photo_client_upload_id: string | null;
  readonly photo_object_key: string | null;
  readonly photo_status: ChatPhotoSnapshot['status'] | null;
  readonly photo_mime_type: 'image/webp' | null;
  readonly photo_size_bytes: number | null;
  readonly photo_width: number | null;
  readonly photo_height: number | null;
  readonly photo_expires_at: Date | string | null;
  readonly photo_attempt_count: number | null;
  readonly photo_last_error_code: string | null;
  readonly photo_attached_at: Date | string | null;
}

interface PhotoRow extends QueryResultRow {
  readonly id: string;
  readonly conversation_id: string;
  readonly uploader_user_id: string;
  readonly client_upload_id: string;
  readonly input_sha256: string;
  readonly object_key: string;
  readonly status: ChatPhotoSnapshot['status'];
  readonly mime_type: 'image/webp';
  readonly size_bytes: number;
  readonly width: number;
  readonly height: number;
  readonly expires_at: Date | string;
  readonly processing_lease_expires_at: Date | string | null;
  readonly attempt_count: number;
  readonly last_error_code: string | null;
  readonly attached_at: Date | string | null;
}

interface ParticipantLockRow extends QueryResultRow {
  readonly client_user_id: string;
  readonly trainer_user_id: string;
  readonly next_sequence: string | number;
  readonly last_message_sequence: string | number | null;
  readonly client_last_read_sequence: string | number;
  readonly trainer_last_read_sequence: string | number;
  readonly client_onboarding_status: ChatActor['onboardingStatus'];
  readonly trainer_active: boolean;
  readonly sender_email: string | null;
  readonly sender_phone: string | null;
  readonly sender_username: string | null;
  readonly sender_first_name: string | null;
  readonly trainer_display_name: string;
}

interface LockedUserRow extends QueryResultRow {
  readonly id: string;
  readonly email_verified: boolean;
  readonly onboarding_status: ChatActor['onboardingStatus'];
}

const MASKED_CLIENT_EMAIL_SQL = `
  substring(split_part(client.email, '@', 1) from 1 for 1)
  || '***@'
  || split_part(client.email, '@', 2)
`;

const MASKED_CLIENT_PHONE_SQL = `
  substring(client.phone from 1 for 2)
  || '***'
  || right(client.phone, 2)
`;

const CLIENT_SECONDARY_LABEL_SQL = `
  CASE
    WHEN client.email IS NOT NULL THEN ${MASKED_CLIENT_EMAIL_SQL}
    WHEN client.phone IS NOT NULL THEN ${MASKED_CLIENT_PHONE_SQL}
    ELSE 'Клиент Kinetra'
  END
`;

const CLIENT_DISPLAY_NAME_SQL = `
  left(
    COALESCE(
      NULLIF(btrim(client.first_name), ''),
      NULLIF(btrim(client.username), ''),
      CASE WHEN client.email IS NULL THEN NULL ELSE ${MASKED_CLIENT_EMAIL_SQL} END,
      CASE WHEN client.phone IS NULL THEN NULL ELSE ${MASKED_CLIENT_PHONE_SQL} END,
      'Клиент Kinetra'
    ),
    120
  )
`;

const CONVERSATION_SELECT = `
  SELECT
    conversation.id AS conversation_id,
    conversation.client_user_id,
    conversation.trainer_user_id,
    conversation.last_message_sequence,
    conversation.client_last_read_sequence,
    conversation.trainer_last_read_sequence,
    conversation.client_unread_count,
    conversation.trainer_unread_count,
    conversation.created_at AS conversation_created_at,
    COALESCE(conversation.last_message_at, conversation.created_at) AS activity_at,
    ${CLIENT_DISPLAY_NAME_SQL} AS client_display_name,
    ${CLIENT_SECONDARY_LABEL_SQL} AS client_secondary_label,
    client.avatar_url AS client_avatar_url,
    trainer_profile.display_name AS trainer_display_name,
    trainer.avatar_url AS trainer_avatar_url,
    last_message.id AS message_id,
    last_message.sequence AS message_sequence,
    last_message.sender_user_id AS message_sender_user_id,
    last_message.sender_role AS message_sender_role,
    last_message.sender_name_snapshot AS message_sender_name,
    last_message.client_message_id AS message_client_id,
    last_message.request_fingerprint AS message_fingerprint,
    last_message.kind AS message_kind,
    last_message.body AS message_body,
    last_message.created_at AS message_created_at,
    photo.id AS photo_id,
    photo.conversation_id AS photo_conversation_id,
    photo.uploader_user_id AS photo_uploader_user_id,
    photo.client_upload_id AS photo_client_upload_id,
    photo.object_key AS photo_object_key,
    photo.status AS photo_status,
    photo.mime_type AS photo_mime_type,
    photo.size_bytes AS photo_size_bytes,
    photo.width AS photo_width,
    photo.height AS photo_height,
    photo.expires_at AS photo_expires_at,
    photo.attempt_count AS photo_attempt_count,
    photo.last_error_code AS photo_last_error_code,
    photo.attached_at AS photo_attached_at
  FROM chat_conversations AS conversation
  JOIN users AS client ON client.id = conversation.client_user_id
  JOIN trainer_profiles AS trainer_profile
    ON trainer_profile.user_id = conversation.trainer_user_id
  JOIN users AS trainer ON trainer.id = conversation.trainer_user_id
  LEFT JOIN chat_messages AS last_message
    ON last_message.conversation_id = conversation.id
   AND last_message.sequence = conversation.last_message_sequence
  LEFT JOIN chat_photos AS photo ON photo.id = last_message.photo_id
`;

const MESSAGE_SELECT = `
  SELECT
    message.id,
    message.conversation_id,
    message.sequence,
    message.sender_user_id,
    message.sender_role,
    message.sender_name_snapshot,
    message.client_message_id,
    message.request_fingerprint,
    message.kind,
    message.body,
    message.created_at,
    photo.id AS photo_id,
    photo.conversation_id AS photo_conversation_id,
    photo.uploader_user_id AS photo_uploader_user_id,
    photo.client_upload_id AS photo_client_upload_id,
    photo.object_key AS photo_object_key,
    photo.status AS photo_status,
    photo.mime_type AS photo_mime_type,
    photo.size_bytes AS photo_size_bytes,
    photo.width AS photo_width,
    photo.height AS photo_height,
    photo.expires_at AS photo_expires_at,
    photo.attempt_count AS photo_attempt_count,
    photo.last_error_code AS photo_last_error_code,
    photo.attached_at AS photo_attached_at
  FROM chat_messages AS message
  LEFT JOIN chat_photos AS photo ON photo.id = message.photo_id
`;

const asDate = (value: Date | string): Date =>
  value instanceof Date ? new Date(value.getTime()) : new Date(value);

const asSafeInteger = (value: string | number, label: string): number => {
  const parsed = Number(value);

  if (!Number.isSafeInteger(parsed)) {
    throw new Error(`PostgreSQL returned an invalid ${label}.`);
  }

  return parsed;
};

const maskEmail = (email: string): string => {
  const [local = '', domain = ''] = email.split('@');
  const first = [...local][0] ?? '*';
  return `${first}***@${domain}`;
};

const maskPhone = (phone: string): string => {
  const suffix = phone.slice(-2);
  return `${phone.slice(0, 2)}***${suffix}`;
};

const boundedDisplayName = (value: string): string => [...value].slice(0, 120).join('');

const clientDisplayName = (input: {
  readonly firstName: string | null;
  readonly username: string | null;
  readonly email: string | null;
  readonly phone: string | null;
}): string =>
  boundedDisplayName(
    input.firstName?.trim() ||
      input.username?.trim() ||
      (input.email === null ? null : maskEmail(input.email)) ||
      (input.phone === null ? null : maskPhone(input.phone)) ||
      'Клиент Kinetra',
  );

const mapConversationPhoto = (row: ConversationRow): ChatPhotoSnapshot | null => {
  if (
    row.photo_id === null ||
    row.photo_conversation_id === null ||
    row.photo_uploader_user_id === null ||
    row.photo_client_upload_id === null ||
    row.photo_object_key === null ||
    row.photo_status === null ||
    row.photo_mime_type === null ||
    row.photo_size_bytes === null ||
    row.photo_width === null ||
    row.photo_height === null ||
    row.photo_expires_at === null ||
    row.photo_attempt_count === null
  ) {
    return null;
  }

  return {
    id: row.photo_id,
    conversationId: row.photo_conversation_id,
    uploaderUserId: row.photo_uploader_user_id,
    clientUploadId: row.photo_client_upload_id,
    objectKey: row.photo_object_key,
    status: row.photo_status,
    mimeType: row.photo_mime_type,
    sizeBytes: row.photo_size_bytes,
    width: row.photo_width,
    height: row.photo_height,
    expiresAt: asDate(row.photo_expires_at),
    attemptCount: row.photo_attempt_count,
    lastErrorCode: row.photo_last_error_code,
    attachedAt: row.photo_attached_at === null ? null : asDate(row.photo_attached_at),
  };
};

const mapConversationMessage = (row: ConversationRow): ChatMessageSnapshot | null => {
  if (
    row.message_id === null ||
    row.message_sequence === null ||
    row.message_sender_user_id === null ||
    row.message_sender_role === null ||
    row.message_sender_name === null ||
    row.message_client_id === null ||
    row.message_fingerprint === null ||
    row.message_kind === null ||
    row.message_created_at === null
  ) {
    return null;
  }

  return {
    id: row.message_id,
    conversationId: row.conversation_id,
    sequence: asSafeInteger(row.message_sequence, 'message sequence'),
    senderUserId: row.message_sender_user_id,
    senderRole: row.message_sender_role,
    senderName: row.message_sender_name,
    clientMessageId: row.message_client_id,
    requestFingerprint: row.message_fingerprint,
    kind: row.message_kind,
    body: row.message_body,
    photo: mapConversationPhoto(row),
    createdAt: asDate(row.message_created_at),
  };
};

const mapConversation = (row: ConversationRow): ChatConversationSnapshot => {
  const client: ChatParticipant = {
    userId: row.client_user_id,
    displayName: row.client_display_name,
    secondaryLabel: row.client_secondary_label,
    avatarUrl: row.client_avatar_url,
  };
  const trainer: ChatParticipant = {
    userId: row.trainer_user_id,
    displayName: row.trainer_display_name,
    secondaryLabel: row.trainer_display_name,
    avatarUrl: row.trainer_avatar_url,
  };

  return {
    id: row.conversation_id,
    client,
    trainer,
    lastMessage: mapConversationMessage(row),
    lastMessageSequence:
      row.last_message_sequence === null
        ? 0
        : asSafeInteger(row.last_message_sequence, 'last message sequence'),
    clientLastReadSequence: asSafeInteger(row.client_last_read_sequence, 'client read sequence'),
    trainerLastReadSequence: asSafeInteger(row.trainer_last_read_sequence, 'trainer read sequence'),
    clientUnreadCount: row.client_unread_count,
    trainerUnreadCount: row.trainer_unread_count,
    createdAt: asDate(row.conversation_created_at),
    activityAt: asDate(row.activity_at),
  };
};

const mapPhotoRow = (row: PhotoRow): ChatPhotoSnapshot => ({
  id: row.id,
  conversationId: row.conversation_id,
  uploaderUserId: row.uploader_user_id,
  clientUploadId: row.client_upload_id,
  objectKey: row.object_key,
  status: row.status,
  mimeType: row.mime_type,
  sizeBytes: row.size_bytes,
  width: row.width,
  height: row.height,
  expiresAt: asDate(row.expires_at),
  attemptCount: row.attempt_count,
  lastErrorCode: row.last_error_code,
  attachedAt: row.attached_at === null ? null : asDate(row.attached_at),
});

const mapMessagePhoto = (row: MessageRow): ChatPhotoSnapshot | null => {
  if (
    row.photo_id === null ||
    row.photo_conversation_id === null ||
    row.photo_uploader_user_id === null ||
    row.photo_client_upload_id === null ||
    row.photo_object_key === null ||
    row.photo_status === null ||
    row.photo_mime_type === null ||
    row.photo_size_bytes === null ||
    row.photo_width === null ||
    row.photo_height === null ||
    row.photo_expires_at === null ||
    row.photo_attempt_count === null
  ) {
    return null;
  }

  return {
    id: row.photo_id,
    conversationId: row.photo_conversation_id,
    uploaderUserId: row.photo_uploader_user_id,
    clientUploadId: row.photo_client_upload_id,
    objectKey: row.photo_object_key,
    status: row.photo_status,
    mimeType: row.photo_mime_type,
    sizeBytes: row.photo_size_bytes,
    width: row.photo_width,
    height: row.photo_height,
    expiresAt: asDate(row.photo_expires_at),
    attemptCount: row.photo_attempt_count,
    lastErrorCode: row.photo_last_error_code,
    attachedAt: row.photo_attached_at === null ? null : asDate(row.photo_attached_at),
  };
};

const mapMessage = (row: MessageRow): ChatMessageSnapshot => ({
  id: row.id,
  conversationId: row.conversation_id,
  sequence: asSafeInteger(row.sequence, 'message sequence'),
  senderUserId: row.sender_user_id,
  senderRole: row.sender_role,
  senderName: row.sender_name_snapshot,
  clientMessageId: row.client_message_id,
  requestFingerprint: row.request_fingerprint,
  kind: row.kind,
  body: row.body,
  photo: mapMessagePhoto(row),
  createdAt: asDate(row.created_at),
});

const rollbackQuietly = async (client: PoolClient): Promise<void> => {
  try {
    await client.query('ROLLBACK');
  } catch {
    console.error('Failed to roll back a chat transaction.');
  }
};

const escapeLikePattern = (value: string): string => value.replace(/[\\%_]/gu, '\\$&');

export interface PostgresChatRepositoryHooks {
  readonly afterMessagesAuthorized?: () => Promise<void>;
  readonly afterActorLocked?: (operation: 'send' | 'reserve') => Promise<void>;
  readonly afterPhotoIdempotencyLocked?: () => Promise<void>;
  readonly afterAdminUsersLocked?: (
    operation: 'create' | 'grant' | 'reassign' | 'revoke',
  ) => Promise<void>;
}

export class PostgresChatRepository implements ChatRepository {
  public constructor(
    private readonly pool: Pool,
    private readonly hooks: PostgresChatRepositoryHooks = {},
  ) {}

  public async withMediaObjectLock<T>(
    objectKey: string,
    operation: (lease: ChatMediaObjectLease) => Promise<T>,
  ): Promise<T> {
    const client = await this.pool.connect();
    let destroyClient = false;

    try {
      await client.query(`SELECT pg_advisory_lock(hashtextextended($1, 0))`, [objectKey]);
      return await operation({
        findPhotoStatus: (photoId, uploaderUserId) =>
          this.findPhotoStatusWith(client, photoId, uploaderUserId),
        markPhotoReady: (input) => this.markPhotoReadyWith(client, input),
        completeMediaDeletion: (key, now) => this.completeMediaDeletionWith(client, key, now),
      });
    } finally {
      try {
        const unlocked = await client.query<{ readonly unlocked: boolean }>(
          `SELECT pg_advisory_unlock(hashtextextended($1, 0)) AS unlocked`,
          [objectKey],
        );

        if (unlocked.rows[0]?.unlocked !== true) {
          destroyClient = true;
        }
      } catch {
        destroyClient = true;
      }

      client.release(destroyClient);
    }
  }

  public async getRealtimeConversation(
    conversationId: string,
  ): Promise<ChatConversationSnapshot | null> {
    const client = await this.pool.connect();

    try {
      await client.query('BEGIN');
      const conversation = await this.loadRealtimeConversation(client, conversationId, true);
      await client.query('COMMIT');
      return conversation;
    } catch (error) {
      await rollbackQuietly(client);
      throw error;
    } finally {
      client.release();
    }
  }

  public async findRealtimeRecipientConversation(
    userId: string,
    role: ChatRole,
    conversationId: string,
  ): Promise<ChatConversationSnapshot | null> {
    const result = await this.pool.query<ConversationRow>(
      `${CONVERSATION_SELECT}
       WHERE conversation.id = $1
         AND client.onboarding_status = 'active'
         AND trainer_profile.is_active = true
         AND (
           ($3::text = 'client' AND conversation.client_user_id = $2)
           OR ($3::text = 'trainer' AND conversation.trainer_user_id = $2)
         )
       LIMIT 1`,
      [conversationId, userId, role],
    );
    const row = result.rows[0];
    return row === undefined ? null : mapConversation(row);
  }

  public async findActor(userId: string): Promise<ChatActor | null> {
    const result = await this.pool.query<ActorRow>(
      `SELECT
         user_record.id,
         user_record.email,
         user_record.phone,
         user_record.avatar_url,
         user_record.username,
         user_record.first_name,
         user_record.onboarding_status,
         trainer.display_name AS trainer_display_name
       FROM users AS user_record
       LEFT JOIN trainer_profiles AS trainer
         ON trainer.user_id = user_record.id
        AND trainer.is_active = true
       WHERE user_record.id = $1
       LIMIT 1`,
      [userId],
    );
    const row = result.rows[0];

    if (row === undefined) {
      return null;
    }

    return {
      userId: row.id,
      role: row.trainer_display_name === null ? 'client' : 'trainer',
      onboardingStatus: row.onboarding_status,
      displayName:
        row.trainer_display_name ??
        clientDisplayName({
          firstName: row.first_name,
          username: row.username,
          email: row.email,
          phone: row.phone,
        }),
      avatarUrl: row.avatar_url,
    };
  }

  public async isSessionActive(userId: string, sessionId: string, now: Date): Promise<boolean> {
    const result = await this.pool.query(
      `SELECT 1
       FROM refresh_tokens AS session
       JOIN users AS user_record ON user_record.id = session.user_id
       WHERE session.id = $1
         AND session.user_id = $2
         AND session.revoked_at IS NULL
         AND session.expires_at > $3
       LIMIT 1`,
      [sessionId, userId, now],
    );
    return result.rowCount === 1;
  }

  public async findConversationForClient(userId: string): Promise<ChatConversationSnapshot | null> {
    const result = await this.pool.query<ConversationRow>(
      `${CONVERSATION_SELECT}
       WHERE conversation.client_user_id = $1
       LIMIT 1`,
      [userId],
    );
    const row = result.rows[0];
    return row === undefined ? null : mapConversation(row);
  }

  public async countTrainerUnread(userId: string): Promise<number> {
    const result = await this.pool.query<{ readonly count: string | number }>(
      `SELECT COALESCE(SUM(conversation.trainer_unread_count), 0)::bigint AS count
       FROM chat_conversations AS conversation
       JOIN trainer_profiles AS trainer
         ON trainer.user_id = conversation.trainer_user_id
        AND trainer.is_active = true
       WHERE conversation.trainer_user_id = $1`,
      [userId],
    );
    return asSafeInteger(result.rows[0]?.count ?? 0, 'trainer unread count');
  }

  public async hasActiveDefaultTrainer(): Promise<boolean> {
    const result = await this.pool.query(
      `SELECT 1
       FROM trainer_profiles
       WHERE is_active = true AND is_default = true
       LIMIT 1`,
    );
    return result.rowCount === 1;
  }

  public async createOrGetConversation(
    clientUserId: string,
    now: Date,
  ): Promise<CreateConversationResult | null> {
    const fastPathConversation = await this.findConversationForClient(clientUserId);

    if (fastPathConversation !== null) {
      return { created: false, conversation: fastPathConversation };
    }

    const client = await this.pool.connect();

    try {
      await client.query('BEGIN');
      await this.lockTrainerAdministration(client);
      const defaultTrainer = await client.query<{ readonly user_id: string }>(
        `SELECT user_id
         FROM trainer_profiles
         WHERE is_active = true AND is_default = true
         LIMIT 1`,
      );
      const trainerUserId = defaultTrainer.rows[0]?.user_id;
      const lockedUsers = await this.lockUsersForUpdate(
        client,
        trainerUserId === undefined ? [clientUserId] : [clientUserId, trainerUserId],
      );
      await this.hooks.afterAdminUsersLocked?.('create');
      const lockedProfiles = await client.query<{
        readonly user_id: string;
        readonly is_active: boolean;
        readonly is_default: boolean;
      }>(
        `SELECT user_id, is_active, is_default
         FROM trainer_profiles
         WHERE user_id = ANY($1::uuid[])
         ORDER BY user_id
         FOR UPDATE`,
        [trainerUserId === undefined ? [clientUserId] : [clientUserId, trainerUserId]],
      );
      const user = lockedUsers.find((row) => row.id === clientUserId);
      const clientIsTrainer = lockedProfiles.rows.some(
        (row) => row.user_id === clientUserId && row.is_active,
      );

      if (user?.onboarding_status !== 'active' || clientIsTrainer) {
        await client.query('COMMIT');
        return null;
      }

      const existing = await this.loadConversationByClient(client, clientUserId);

      if (existing !== null) {
        await client.query('COMMIT');
        return { created: false, conversation: existing };
      }

      const trainerIsStillDefault = lockedProfiles.rows.some(
        (row) => row.user_id === trainerUserId && row.is_active && row.is_default,
      );

      if (
        trainerUserId === undefined ||
        !trainerIsStillDefault ||
        !lockedUsers.some((row) => row.id === trainerUserId)
      ) {
        await client.query('COMMIT');
        return null;
      }

      const inserted = await client.query<{ readonly id: string }>(
        `INSERT INTO chat_conversations (
           client_user_id, trainer_user_id, created_at, updated_at
         )
         VALUES ($1, $2, $3, $3)
         ON CONFLICT (client_user_id) DO NOTHING
         RETURNING id`,
        [clientUserId, trainerUserId, now],
      );
      const conversation = await this.loadConversationByClient(client, clientUserId);

      if (conversation === null) {
        throw new Error('PostgreSQL did not return the created chat conversation.');
      }

      await client.query('COMMIT');
      return { created: inserted.rowCount === 1, conversation };
    } catch (error) {
      await rollbackQuietly(client);
      throw error;
    } finally {
      client.release();
    }
  }

  public async listTrainerConversations(input: ListConversationsInput): Promise<ConversationPage> {
    const values: unknown[] = [input.trainerUserId];
    const conditions = ['conversation.trainer_user_id = $1', 'trainer_profile.is_active = true'];

    if (input.filter === 'unread') {
      conditions.push('conversation.trainer_unread_count > 0');
    }

    if (input.query !== null) {
      values.push(`%${escapeLikePattern(input.query)}%`);
      const parameter = `$${values.length}`;
      conditions.push(`(
        ${CLIENT_DISPLAY_NAME_SQL} ILIKE ${parameter} ESCAPE '\\'
        OR ${CLIENT_SECONDARY_LABEL_SQL} ILIKE ${parameter} ESCAPE '\\'
      )`);
    }

    if (input.cursor !== null) {
      values.push(input.cursor.activityAt, input.cursor.conversationId);
      conditions.push(
        `(COALESCE(conversation.last_message_at, conversation.created_at), conversation.id)
         < ($${values.length - 1}::timestamptz, $${values.length}::uuid)`,
      );
    }

    values.push(input.limit + 1);
    const result = await this.pool.query<ConversationRow>(
      `${CONVERSATION_SELECT}
       WHERE ${conditions.join('\n AND ')}
       ORDER BY
         COALESCE(conversation.last_message_at, conversation.created_at) DESC,
         conversation.id DESC
       LIMIT $${values.length}`,
      values,
    );
    const hasMore = result.rows.length > input.limit;
    return {
      items: result.rows.slice(0, input.limit).map(mapConversation),
      hasMore,
    };
  }

  public async findTrainerConversation(
    trainerUserId: string,
    conversationId: string,
  ): Promise<ChatConversationSnapshot | null> {
    const result = await this.pool.query<ConversationRow>(
      `${CONVERSATION_SELECT}
       WHERE conversation.id = $1
         AND conversation.trainer_user_id = $2
         AND trainer_profile.is_active = true
       LIMIT 1`,
      [conversationId, trainerUserId],
    );
    const row = result.rows[0];
    return row === undefined ? null : mapConversation(row);
  }

  public async listMessages(input: ListMessagesInput): Promise<MessagePage | null> {
    const client = await this.pool.connect();

    try {
      await client.query('BEGIN');
      const conversation = await this.loadAuthorizedConversation(
        client,
        input.userId,
        input.conversationId,
        true,
      );

      if (conversation === null) {
        await client.query('COMMIT');
        return null;
      }

      await this.hooks.afterMessagesAuthorized?.();

      const boundary = input.beforeSequence ?? input.afterSequence;

      if (boundary !== null && boundary > conversation.lastMessageSequence) {
        throw new HttpError(400, 'CHAT_INVALID_REQUEST', 'Message cursor is beyond chat history.');
      }

      let result;
      let hasMoreBefore = false;
      let hasMoreAfter = false;
      const participantPredicate = `EXISTS (
        SELECT 1
        FROM chat_conversations AS authorized
        WHERE authorized.id = message.conversation_id
          AND (authorized.client_user_id = $4 OR authorized.trainer_user_id = $4)
      )`;

      if (input.afterSequence !== null) {
        result = await client.query<MessageRow>(
          `${MESSAGE_SELECT}
           WHERE message.conversation_id = $1
             AND message.sequence > $2
             AND ${participantPredicate}
           ORDER BY message.sequence ASC
           LIMIT $3`,
          [input.conversationId, input.afterSequence, input.limit + 1, input.userId],
        );
        hasMoreAfter = result.rows.length > input.limit;
      } else {
        const before = input.beforeSequence ?? conversation.lastMessageSequence + 1;
        result = await client.query<MessageRow>(
          `${MESSAGE_SELECT}
           WHERE message.conversation_id = $1
             AND message.sequence < $2
             AND ${participantPredicate}
           ORDER BY message.sequence DESC
           LIMIT $3`,
          [input.conversationId, before, input.limit + 1, input.userId],
        );
        hasMoreBefore = result.rows.length > input.limit;
        result.rows.reverse();
      }

      const page = {
        conversation,
        messages: (input.afterSequence === null
          ? result.rows.slice(hasMoreBefore ? 1 : 0)
          : result.rows.slice(0, input.limit)
        ).map(mapMessage),
        hasMoreBefore,
        hasMoreAfter,
      };
      await client.query('COMMIT');
      return page;
    } catch (error) {
      await rollbackQuietly(client);
      throw error;
    } finally {
      client.release();
    }
  }

  public async sendMessage(
    input: SendMessageRepositoryInput,
  ): Promise<SendMessageRepositoryResult> {
    const client = await this.pool.connect();

    try {
      await client.query('BEGIN');
      const actorExists = await this.lockActorUser(client, input.userId);

      if (!actorExists) {
        await client.query('COMMIT');
        return { kind: 'not_found' };
      }

      await this.hooks.afterActorLocked?.('send');

      const participant = await this.lockParticipant(client, input.conversationId, input.userId);

      if (participant === null) {
        await client.query('COMMIT');
        return { kind: 'not_found' };
      }

      const senderRole =
        participant.client_user_id === input.userId ? ('client' as const) : ('trainer' as const);

      if (
        (senderRole === 'client' && participant.client_onboarding_status !== 'active') ||
        (senderRole === 'trainer' && !participant.trainer_active)
      ) {
        await client.query('COMMIT');
        return { kind: 'not_available' };
      }

      const existing = await this.loadIdempotentMessage(
        client,
        input.conversationId,
        input.userId,
        input.clientMessageId,
      );

      if (existing !== null) {
        if (existing.requestFingerprint !== input.requestFingerprint) {
          await client.query('COMMIT');
          return { kind: 'idempotency_conflict' };
        }

        const conversation = await this.loadConversationById(client, input.conversationId);

        if (conversation === null) {
          throw new Error('Chat conversation disappeared during idempotent replay.');
        }

        await client.query('COMMIT');
        return { kind: 'replay', conversation, message: existing };
      }

      if (input.photoId !== null) {
        const photo = await client.query<PhotoRow>(
          `SELECT *
           FROM chat_photos
           WHERE id = $1 AND conversation_id = $2
           FOR UPDATE`,
          [input.photoId, input.conversationId],
        );
        const row = photo.rows[0];

        if (row === undefined || row.uploader_user_id !== input.userId) {
          await client.query('COMMIT');
          return { kind: 'photo_not_ready' };
        }

        if (row.status === 'attached') {
          await client.query('COMMIT');
          return { kind: 'photo_already_attached' };
        }

        if (row.status !== 'ready' || asDate(row.expires_at).getTime() <= input.now.getTime()) {
          await client.query('COMMIT');
          return { kind: 'photo_not_ready' };
        }
      }

      const sequence = asSafeInteger(participant.next_sequence, 'next message sequence');
      const senderName =
        senderRole === 'trainer'
          ? participant.trainer_display_name
          : clientDisplayName({
              firstName: participant.sender_first_name,
              username: participant.sender_username,
              email: participant.sender_email,
              phone: participant.sender_phone,
            });
      const messageId = randomUUID();
      await client.query(
        `INSERT INTO chat_messages (
           id,
           conversation_id,
           sequence,
           sender_user_id,
           sender_role,
           sender_name_snapshot,
           client_message_id,
           request_fingerprint,
           kind,
           body,
           photo_id,
           created_at
         )
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`,
        [
          messageId,
          input.conversationId,
          sequence,
          input.userId,
          senderRole,
          senderName,
          input.clientMessageId,
          input.requestFingerprint,
          input.kind,
          input.body,
          input.photoId,
          input.now,
        ],
      );

      if (input.photoId !== null) {
        await client.query(
          `UPDATE chat_photos
           SET status = 'attached',
               attached_at = $3,
               processing_started_at = NULL,
               processing_lease_expires_at = NULL,
               last_error_code = NULL,
               updated_at = $3
           WHERE id = $1 AND conversation_id = $2`,
          [input.photoId, input.conversationId, input.now],
        );
      }

      await client.query(
        `UPDATE chat_conversations
         SET next_sequence = $2 + 1,
             last_message_sequence = $2,
             last_message_at = $3,
             client_unread_count = client_unread_count + CASE WHEN $4 = 'trainer' THEN 1 ELSE 0 END,
             trainer_unread_count = trainer_unread_count + CASE WHEN $4 = 'client' THEN 1 ELSE 0 END,
             updated_at = $3
         WHERE id = $1`,
        [input.conversationId, sequence, input.now, senderRole],
      );
      const [conversation, message] = await Promise.all([
        this.loadConversationById(client, input.conversationId),
        this.loadMessageById(client, messageId),
      ]);

      if (conversation === null || message === null) {
        throw new Error('PostgreSQL did not return the committed chat message.');
      }

      await client.query('COMMIT');
      return { kind: 'created', conversation, message };
    } catch (error) {
      await rollbackQuietly(client);
      throw error;
    } finally {
      client.release();
    }
  }

  public async markRead(input: ReadRepositoryInput): Promise<ReadRepositoryResult> {
    const client = await this.pool.connect();

    try {
      await client.query('BEGIN');
      const participant = await this.lockParticipant(client, input.conversationId, input.userId);

      if (participant === null) {
        await client.query('COMMIT');
        return { kind: 'not_found' };
      }

      const lastSequence =
        participant.last_message_sequence === null
          ? 0
          : asSafeInteger(participant.last_message_sequence, 'last message sequence');

      if (input.throughSequence > lastSequence) {
        await client.query('COMMIT');
        return { kind: 'future_cursor' };
      }

      const readerRole =
        participant.client_user_id === input.userId ? ('client' as const) : ('trainer' as const);
      const oldSequence = asSafeInteger(
        readerRole === 'client'
          ? participant.client_last_read_sequence
          : participant.trainer_last_read_sequence,
        'read sequence',
      );
      const throughSequence = Math.max(oldSequence, input.throughSequence);

      if (throughSequence > oldSequence) {
        if (readerRole === 'client') {
          await client.query(
            `UPDATE chat_conversations AS conversation
             SET client_last_read_sequence = $2,
                 client_unread_count = (
                   SELECT COUNT(*)::integer
                   FROM chat_messages AS message
                   WHERE message.conversation_id = conversation.id
                     AND message.sender_role = 'trainer'
                     AND message.sequence > $2
                 ),
                 updated_at = $3
             WHERE conversation.id = $1`,
            [input.conversationId, throughSequence, input.now],
          );
        } else {
          await client.query(
            `UPDATE chat_conversations AS conversation
             SET trainer_last_read_sequence = $2,
                 trainer_unread_count = (
                   SELECT COUNT(*)::integer
                   FROM chat_messages AS message
                   WHERE message.conversation_id = conversation.id
                     AND message.sender_role = 'client'
                     AND message.sequence > $2
                 ),
                 updated_at = $3
             WHERE conversation.id = $1`,
            [input.conversationId, throughSequence, input.now],
          );
        }
      }

      const conversation = await this.loadConversationById(client, input.conversationId);

      if (conversation === null) {
        throw new Error('Chat conversation disappeared during read update.');
      }

      await client.query('COMMIT');
      return {
        kind: throughSequence > oldSequence ? 'updated' : 'unchanged',
        conversation,
        readerRole,
      };
    } catch (error) {
      await rollbackQuietly(client);
      throw error;
    } finally {
      client.release();
    }
  }

  public async reservePhoto(input: ReservePhotoInput): Promise<ReservePhotoResult> {
    const client = await this.pool.connect();

    try {
      await client.query('BEGIN');
      const actorExists = await this.lockActorUser(client, input.uploaderUserId);

      if (!actorExists) {
        await client.query('COMMIT');
        return { kind: 'not_found' };
      }

      await this.hooks.afterActorLocked?.('reserve');

      const participant = await this.lockParticipant(
        client,
        input.conversationId,
        input.uploaderUserId,
      );

      if (participant === null) {
        await client.query('COMMIT');
        return { kind: 'not_found' };
      }

      await this.lockPhotoIdempotency(client, input.uploaderUserId, input.clientUploadId);
      await this.hooks.afterPhotoIdempotencyLocked?.();

      const existing = await client.query<PhotoRow>(
        `SELECT *
         FROM chat_photos
         WHERE uploader_user_id = $1 AND client_upload_id = $2
         FOR UPDATE`,
        [input.uploaderUserId, input.clientUploadId],
      );
      const row = existing.rows[0];

      if (row !== undefined) {
        if (
          row.input_sha256 !== input.inputSha256 ||
          row.conversation_id !== input.conversationId
        ) {
          await client.query('COMMIT');
          return { kind: 'idempotency_conflict' };
        }

        if (row.status === 'ready' || row.status === 'attached') {
          await client.query('COMMIT');
          return { kind: row.status, photo: mapPhotoRow(row) };
        }

        if (
          row.status === 'processing' &&
          row.processing_lease_expires_at !== null &&
          asDate(row.processing_lease_expires_at).getTime() > input.now.getTime()
        ) {
          await client.query('COMMIT');
          return { kind: 'processing', photo: mapPhotoRow(row) };
        }

        if (row.attempt_count >= 3) {
          await client.query('COMMIT');
          return { kind: 'retry_exhausted' };
        }

        const retried = await client.query<PhotoRow>(
          `UPDATE chat_photos
           SET status = 'processing',
               expires_at = $3,
               processing_started_at = $4,
               processing_lease_expires_at = $5,
               attempt_count = attempt_count + 1,
               last_error_code = NULL,
               attached_at = NULL,
               updated_at = $4
           WHERE id = $1 AND uploader_user_id = $2
           RETURNING *`,
          [row.id, input.uploaderUserId, input.expiresAt, input.now, input.leaseExpiresAt],
        );
        const retriedRow = retried.rows[0];

        if (retriedRow === undefined) {
          throw new Error('PostgreSQL did not return the retried chat photo.');
        }

        await client.query('COMMIT');
        return { kind: 'reserved', photo: mapPhotoRow(retriedRow) };
      }

      const inserted = await client.query<PhotoRow>(
        `INSERT INTO chat_photos (
           id,
           conversation_id,
           uploader_user_id,
           client_upload_id,
           input_sha256,
           object_key,
           mime_type,
           size_bytes,
           width,
           height,
           status,
           expires_at,
           processing_started_at,
           processing_lease_expires_at,
           attempt_count,
           created_at,
           updated_at
         )
         VALUES ($1, $2, $3, $4, $5, $6, 'image/webp', 1, 1, 1, 'processing', $7, $8, $9, 1, $8, $8)
         RETURNING *`,
        [
          input.id,
          input.conversationId,
          input.uploaderUserId,
          input.clientUploadId,
          input.inputSha256,
          input.objectKey,
          input.expiresAt,
          input.now,
          input.leaseExpiresAt,
        ],
      );
      const insertedRow = inserted.rows[0];

      if (insertedRow === undefined) {
        throw new Error('PostgreSQL did not return the reserved chat photo.');
      }

      await client.query('COMMIT');
      return { kind: 'reserved', photo: mapPhotoRow(insertedRow) };
    } catch (error) {
      await rollbackQuietly(client);
      throw error;
    } finally {
      client.release();
    }
  }

  public async markPhotoReady(input: ReadyPhotoInput): Promise<ChatPhotoSnapshot | null> {
    return this.markPhotoReadyWith(this.pool, input);
  }

  private async markPhotoReadyWith(
    queryable: Pool | PoolClient,
    input: ReadyPhotoInput,
  ): Promise<ChatPhotoSnapshot | null> {
    const result = await queryable.query<PhotoRow>(
      `UPDATE chat_photos
       SET status = 'ready',
           mime_type = $3,
           size_bytes = $4,
           width = $5,
           height = $6,
           processing_started_at = NULL,
           processing_lease_expires_at = NULL,
           last_error_code = NULL,
           updated_at = $7
       WHERE id = $1
         AND uploader_user_id = $2
         AND status = 'processing'
         AND EXISTS (
           SELECT 1
           FROM chat_conversations AS conversation
           WHERE conversation.id = chat_photos.conversation_id
             AND (
               conversation.client_user_id = $2
               OR conversation.trainer_user_id = $2
             )
         )
       RETURNING *`,
      [
        input.photoId,
        input.uploaderUserId,
        input.mimeType,
        input.sizeBytes,
        input.width,
        input.height,
        input.now,
      ],
    );
    const row = result.rows[0];
    return row === undefined ? null : mapPhotoRow(row);
  }

  public async markPhotoFailed(
    photoId: string,
    uploaderUserId: string,
    errorCode: string,
    now: Date,
  ): Promise<void> {
    await this.pool.query(
      `UPDATE chat_photos
       SET status = 'failed',
           processing_started_at = NULL,
           processing_lease_expires_at = NULL,
           last_error_code = $3,
           updated_at = $4
       WHERE id = $1
         AND uploader_user_id = $2
         AND status = 'processing'
         AND EXISTS (
           SELECT 1
           FROM chat_conversations AS conversation
           WHERE conversation.id = chat_photos.conversation_id
             AND (
               conversation.client_user_id = $2
               OR conversation.trainer_user_id = $2
             )
         )`,
      [photoId, uploaderUserId, errorCode.slice(0, 64), now],
    );
  }

  public async findPhotoStatus(
    photoId: string,
    uploaderUserId: string,
  ): Promise<ChatPhotoSnapshot | null> {
    return this.findPhotoStatusWith(this.pool, photoId, uploaderUserId);
  }

  private async findPhotoStatusWith(
    queryable: Pool | PoolClient,
    photoId: string,
    uploaderUserId: string,
  ): Promise<ChatPhotoSnapshot | null> {
    const result = await queryable.query<PhotoRow>(
      `SELECT photo.*
       FROM chat_photos AS photo
       JOIN chat_conversations AS conversation ON conversation.id = photo.conversation_id
       WHERE photo.id = $1
         AND photo.uploader_user_id = $2
         AND (
           conversation.client_user_id = $2
           OR conversation.trainer_user_id = $2
         )
       LIMIT 1`,
      [photoId, uploaderUserId],
    );
    const row = result.rows[0];
    return row === undefined ? null : mapPhotoRow(row);
  }

  public async findPhotoAccess(
    photoId: string,
    userId: string,
    now: Date,
  ): Promise<PhotoAccessSnapshot | null> {
    const result = await this.pool.query<PhotoRow>(
      `SELECT photo.*
       FROM chat_photos AS photo
       JOIN chat_conversations AS conversation ON conversation.id = photo.conversation_id
       WHERE photo.id = $1
         AND (conversation.client_user_id = $2 OR conversation.trainer_user_id = $2)
         AND (
           (
             photo.status IN ('processing', 'ready')
             AND photo.uploader_user_id = $2
             AND photo.expires_at > $3
           )
           OR (
             photo.status = 'attached'
             AND EXISTS (
               SELECT 1 FROM chat_messages AS message
               WHERE message.photo_id = photo.id
                 AND message.conversation_id = photo.conversation_id
             )
           )
         )
       LIMIT 1`,
      [photoId, userId, now],
    );
    const row = result.rows[0];
    return row === undefined ? null : { photo: mapPhotoRow(row), canAccess: true };
  }

  public async expireStalePhotos(now: Date, limit: number): Promise<number> {
    const result = await this.pool.query(
      `WITH stale AS (
         SELECT id
         FROM chat_photos
         WHERE (
           status = 'processing' AND processing_lease_expires_at <= $1
         ) OR (
           status = 'ready' AND expires_at <= $1
         ) OR (
           status = 'failed' AND updated_at <= $1 - INTERVAL '24 hours'
         )
         ORDER BY updated_at, id
         LIMIT $2
         FOR UPDATE SKIP LOCKED
       )
       DELETE FROM chat_photos AS photo
       USING stale
       WHERE photo.id = stale.id`,
      [now, limit],
    );
    return result.rowCount ?? 0;
  }

  public async claimMediaDeletionJobs(
    now: Date,
    limit: number,
  ): Promise<readonly MediaDeletionJob[]> {
    const client = await this.pool.connect();

    try {
      await client.query('BEGIN');
      const result = await client.query<{
        readonly object_key: string;
        readonly attempt_count: number;
      }>(
        `WITH candidates AS (
           SELECT object_key
           FROM chat_media_deletion_jobs
           WHERE completed_at IS NULL
             AND next_attempt_at <= $1
             AND (locked_at IS NULL OR locked_at <= $1 - INTERVAL '15 minutes')
           ORDER BY next_attempt_at, requested_at, object_key
           LIMIT $2
           FOR UPDATE SKIP LOCKED
         )
         UPDATE chat_media_deletion_jobs AS job
         SET locked_at = $1,
             attempt_count = job.attempt_count + 1
         FROM candidates
         WHERE job.object_key = candidates.object_key
         RETURNING job.object_key, job.attempt_count`,
        [now, limit],
      );
      await client.query('COMMIT');
      return result.rows.map((row) => ({
        objectKey: row.object_key,
        attemptCount: row.attempt_count,
      }));
    } catch (error) {
      await rollbackQuietly(client);
      throw error;
    } finally {
      client.release();
    }
  }

  public async getMediaDeletionBacklog(now: Date): Promise<MediaDeletionBacklog> {
    const result = await this.pool.query<{
      readonly pending_count: string | number;
      readonly due_count: string | number;
      readonly oldest_requested_at: Date | string | null;
    }>(
      `SELECT
         COUNT(*)::bigint AS pending_count,
         COUNT(*) FILTER (WHERE next_attempt_at <= $1)::bigint AS due_count,
         MIN(requested_at) AS oldest_requested_at
       FROM chat_media_deletion_jobs
       WHERE completed_at IS NULL`,
      [now],
    );
    const row = result.rows[0];
    return {
      pendingCount: asSafeInteger(row?.pending_count ?? 0, 'media deletion pending count'),
      dueCount: asSafeInteger(row?.due_count ?? 0, 'media deletion due count'),
      oldestRequestedAt:
        row?.oldest_requested_at === null || row?.oldest_requested_at === undefined
          ? null
          : asDate(row.oldest_requested_at),
    };
  }

  public async completeMediaDeletion(objectKey: string, now: Date): Promise<void> {
    await this.completeMediaDeletionWith(this.pool, objectKey, now);
  }

  private async completeMediaDeletionWith(
    queryable: Pool | PoolClient,
    objectKey: string,
    now: Date,
  ): Promise<void> {
    await queryable.query(
      `UPDATE chat_media_deletion_jobs
       SET completed_at = $2, locked_at = NULL, last_error_code = NULL
       WHERE object_key = $1`,
      [objectKey, now],
    );
  }

  public async retryMediaDeletion(
    objectKey: string,
    errorCode: string,
    nextAttemptAt: Date,
  ): Promise<void> {
    await this.pool.query(
      `UPDATE chat_media_deletion_jobs
       SET next_attempt_at = $3,
           last_error_code = $2,
           locked_at = NULL
       WHERE object_key = $1 AND completed_at IS NULL`,
      [objectKey, errorCode.slice(0, 64), nextAttemptAt],
    );
  }

  public async grantTrainer(
    input: TrainerGrantInput,
  ): Promise<'granted' | 'user_not_found' | 'email_not_verified' | 'client_conversation'> {
    const client = await this.pool.connect();

    try {
      await client.query('BEGIN');
      await this.lockTrainerAdministration(client);
      const currentDefault = input.makeDefault
        ? await client.query<{ readonly user_id: string }>(
            `SELECT user_id
             FROM trainer_profiles
             WHERE is_active = true AND is_default = true
             LIMIT 1`,
          )
        : null;
      const currentDefaultUserId = currentDefault?.rows[0]?.user_id;
      const relevantUserIds =
        currentDefaultUserId === undefined ? [input.userId] : [input.userId, currentDefaultUserId];
      const lockedUsers = await this.lockUsersForUpdate(client, relevantUserIds);
      await this.hooks.afterAdminUsersLocked?.('grant');
      await client.query(
        `SELECT user_id
         FROM trainer_profiles
         WHERE user_id = ANY($1::uuid[])
         ORDER BY user_id
         FOR UPDATE`,
        [relevantUserIds],
      );
      const row = lockedUsers.find((candidate) => candidate.id === input.userId);

      if (row === undefined) {
        await client.query('COMMIT');
        return 'user_not_found';
      }

      if (!row.email_verified) {
        await client.query('COMMIT');
        return 'email_not_verified';
      }

      const clientConversation = await client.query(
        `SELECT 1 FROM chat_conversations WHERE client_user_id = $1 LIMIT 1 FOR UPDATE`,
        [input.userId],
      );

      if (clientConversation.rowCount === 1) {
        await client.query('COMMIT');
        return 'client_conversation';
      }

      if (input.makeDefault) {
        await client.query(
          `UPDATE trainer_profiles
           SET is_default = false, updated_at = $1
           WHERE is_default = true AND user_id <> $2`,
          [input.now, input.userId],
        );
      }

      await client.query(
        `INSERT INTO trainer_profiles (
           user_id, display_name, is_active, is_default, created_at, updated_at
         )
         VALUES ($1, $2, true, $3, $4, $4)
         ON CONFLICT (user_id)
         DO UPDATE SET
           display_name = EXCLUDED.display_name,
           is_active = true,
           is_default = CASE
             WHEN $3 THEN true ELSE trainer_profiles.is_default
           END,
           updated_at = EXCLUDED.updated_at`,
        [input.userId, input.displayName, input.makeDefault, input.now],
      );
      await client.query('COMMIT');
      return 'granted';
    } catch (error) {
      await rollbackQuietly(client);
      throw error;
    } finally {
      client.release();
    }
  }

  public async reassignTrainer(input: TrainerReassignInput): Promise<number | null> {
    const client = await this.pool.connect();

    try {
      await client.query('BEGIN');
      await this.lockTrainerAdministration(client);
      const lockedUsers = await this.lockUsersForUpdate(client, [
        input.fromTrainerUserId,
        input.toTrainerUserId,
      ]);
      await this.hooks.afterAdminUsersLocked?.('reassign');

      if (input.fromTrainerUserId === input.toTrainerUserId || lockedUsers.length !== 2) {
        await client.query('COMMIT');
        return null;
      }

      const trainers = await client.query<{ readonly user_id: string }>(
        `SELECT user_id
         FROM trainer_profiles
         WHERE user_id = ANY($1::uuid[]) AND is_active = true
         ORDER BY user_id
         FOR UPDATE`,
        [[input.fromTrainerUserId, input.toTrainerUserId]],
      );

      if (trainers.rowCount !== 2) {
        await client.query('COMMIT');
        return null;
      }

      let result;

      if (input.conversationIds === null) {
        await client.query(
          `SELECT id
           FROM chat_conversations
           WHERE trainer_user_id = $1
           ORDER BY id
           FOR UPDATE`,
          [input.fromTrainerUserId],
        );
        await client.query(
          `DELETE FROM chat_photos AS photo
           USING chat_conversations AS conversation
           WHERE photo.conversation_id = conversation.id
             AND conversation.trainer_user_id = $1
             AND photo.uploader_user_id = $1
             AND photo.status <> 'attached'`,
          [input.fromTrainerUserId],
        );
        result = await client.query(
          `UPDATE chat_conversations
           SET trainer_user_id = $2, updated_at = $3
           WHERE trainer_user_id = $1`,
          [input.fromTrainerUserId, input.toTrainerUserId, input.now],
        );
      } else {
        const locked = await client.query<{ readonly id: string }>(
          `SELECT id
           FROM chat_conversations
           WHERE id = ANY($1::uuid[]) AND trainer_user_id = $2
           ORDER BY id
           FOR UPDATE`,
          [[...input.conversationIds], input.fromTrainerUserId],
        );

        if (locked.rowCount !== input.conversationIds.length) {
          await client.query('ROLLBACK');
          return null;
        }

        await client.query(
          `DELETE FROM chat_photos AS photo
           USING chat_conversations AS conversation
           WHERE photo.conversation_id = conversation.id
             AND conversation.id = ANY($1::uuid[])
             AND conversation.trainer_user_id = $2
             AND photo.uploader_user_id = $2
             AND photo.status <> 'attached'`,
          [[...input.conversationIds], input.fromTrainerUserId],
        );

        result = await client.query(
          `UPDATE chat_conversations
           SET trainer_user_id = $2, updated_at = $3
           WHERE id = ANY($1::uuid[]) AND trainer_user_id = $4`,
          [[...input.conversationIds], input.toTrainerUserId, input.now, input.fromTrainerUserId],
        );
      }

      await client.query('COMMIT');
      return result.rowCount ?? 0;
    } catch (error) {
      await rollbackQuietly(client);
      throw error;
    } finally {
      client.release();
    }
  }

  public async revokeTrainer(
    userId: string,
    now: Date,
  ): Promise<'revoked' | 'not_found' | 'assigned' | 'default'> {
    const client = await this.pool.connect();

    try {
      await client.query('BEGIN');
      await this.lockTrainerAdministration(client);
      const lockedUsers = await this.lockUsersForUpdate(client, [userId]);

      if (lockedUsers.length !== 1) {
        await client.query('COMMIT');
        return 'not_found';
      }

      await this.hooks.afterAdminUsersLocked?.('revoke');
      const profile = await client.query<{ readonly is_default: boolean }>(
        `SELECT is_default
         FROM trainer_profiles
         WHERE user_id = $1 AND is_active = true
         FOR UPDATE`,
        [userId],
      );
      const row = profile.rows[0];

      if (row === undefined) {
        await client.query('COMMIT');
        return 'not_found';
      }

      const assigned = await client.query(
        `SELECT 1
         FROM chat_conversations
         WHERE trainer_user_id = $1
         LIMIT 1
         FOR UPDATE`,
        [userId],
      );

      if (assigned.rowCount === 1) {
        await client.query('COMMIT');
        return 'assigned';
      }

      if (row.is_default) {
        await client.query('COMMIT');
        return 'default';
      }

      await client.query(
        `UPDATE trainer_profiles
         SET is_active = false, is_default = false, updated_at = $2
         WHERE user_id = $1`,
        [userId, now],
      );
      await client.query('COMMIT');
      return 'revoked';
    } catch (error) {
      await rollbackQuietly(client);
      throw error;
    } finally {
      client.release();
    }
  }

  private async loadConversationByClient(
    queryable: Pool | PoolClient,
    userId: string,
  ): Promise<ChatConversationSnapshot | null> {
    const result = await queryable.query<ConversationRow>(
      `${CONVERSATION_SELECT}
       WHERE conversation.client_user_id = $1
       LIMIT 1`,
      [userId],
    );
    const row = result.rows[0];
    return row === undefined ? null : mapConversation(row);
  }

  private async loadConversationById(
    queryable: Pool | PoolClient,
    conversationId: string,
    lockForShare = false,
  ): Promise<ChatConversationSnapshot | null> {
    const result = await queryable.query<ConversationRow>(
      `${CONVERSATION_SELECT}
       WHERE conversation.id = $1
       LIMIT 1
       ${lockForShare ? 'FOR SHARE OF conversation' : ''}`,
      [conversationId],
    );
    const row = result.rows[0];
    return row === undefined ? null : mapConversation(row);
  }

  private async loadRealtimeConversation(
    queryable: Pool | PoolClient,
    conversationId: string,
    lockForShare = false,
  ): Promise<ChatConversationSnapshot | null> {
    const result = await queryable.query<ConversationRow>(
      `${CONVERSATION_SELECT}
       WHERE conversation.id = $1
         AND client.onboarding_status = 'active'
         AND trainer_profile.is_active = true
       LIMIT 1
       ${lockForShare ? 'FOR SHARE OF conversation' : ''}`,
      [conversationId],
    );
    const row = result.rows[0];
    return row === undefined ? null : mapConversation(row);
  }

  private async loadAuthorizedConversation(
    queryable: Pool | PoolClient,
    userId: string,
    conversationId: string,
    lockForShare = false,
  ): Promise<ChatConversationSnapshot | null> {
    const result = await queryable.query<ConversationRow>(
      `${CONVERSATION_SELECT}
       WHERE conversation.id = $1
         AND (
           conversation.client_user_id = $2
           OR (
             conversation.trainer_user_id = $2
             AND trainer_profile.is_active = true
           )
         )
       LIMIT 1
       ${lockForShare ? 'FOR SHARE OF conversation' : ''}`,
      [conversationId, userId],
    );
    const row = result.rows[0];
    return row === undefined ? null : mapConversation(row);
  }

  private async lockParticipant(
    client: PoolClient,
    conversationId: string,
    userId: string,
  ): Promise<ParticipantLockRow | null> {
    const result = await client.query<ParticipantLockRow>(
      `SELECT
         conversation.client_user_id,
         conversation.trainer_user_id,
         conversation.next_sequence,
         conversation.last_message_sequence,
         conversation.client_last_read_sequence,
         conversation.trainer_last_read_sequence,
         client.onboarding_status AS client_onboarding_status,
         trainer_profile.is_active AS trainer_active,
         sender.email AS sender_email,
         sender.phone AS sender_phone,
         sender.username AS sender_username,
         sender.first_name AS sender_first_name,
         trainer_profile.display_name AS trainer_display_name
       FROM chat_conversations AS conversation
       JOIN users AS client ON client.id = conversation.client_user_id
       JOIN trainer_profiles AS trainer_profile
         ON trainer_profile.user_id = conversation.trainer_user_id
       JOIN users AS sender ON sender.id = $2
       WHERE conversation.id = $1
         AND (conversation.client_user_id = $2 OR conversation.trainer_user_id = $2)
       FOR UPDATE OF conversation`,
      [conversationId, userId],
    );
    return result.rows[0] ?? null;
  }

  private async lockTrainerAdministration(client: PoolClient): Promise<void> {
    await client.query(`SELECT pg_advisory_xact_lock(hashtextextended($1, 0))`, [
      'kinetra:chat:trainer-administration:v1',
    ]);
  }

  private async lockPhotoIdempotency(
    client: PoolClient,
    uploaderUserId: string,
    clientUploadId: string,
  ): Promise<void> {
    await client.query(
      `SELECT pg_advisory_xact_lock(
         hashtextextended(
           'kinetra:chat:photo-idempotency:v1:' || $1::uuid::text || ':' || $2::uuid::text,
           0
         )
       )`,
      [uploaderUserId, clientUploadId],
    );
  }

  private async lockUsersForUpdate(
    client: PoolClient,
    userIds: readonly string[],
  ): Promise<LockedUserRow[]> {
    const uniqueUserIds = [...new Set(userIds)].sort();

    if (uniqueUserIds.length === 0) {
      return [];
    }

    const result = await client.query<LockedUserRow>(
      `SELECT id, email_verified, onboarding_status
       FROM users
       WHERE id = ANY($1::uuid[])
       ORDER BY id
       FOR UPDATE`,
      [uniqueUserIds],
    );
    return result.rows;
  }

  private async lockActorUser(client: PoolClient, userId: string): Promise<boolean> {
    const result = await client.query(
      `SELECT id
       FROM users
       WHERE id = $1
       FOR KEY SHARE`,
      [userId],
    );
    return result.rowCount === 1;
  }

  private async loadIdempotentMessage(
    client: PoolClient,
    conversationId: string,
    userId: string,
    clientMessageId: string,
  ): Promise<ChatMessageSnapshot | null> {
    const result = await client.query<MessageRow>(
      `${MESSAGE_SELECT}
       WHERE message.conversation_id = $1
         AND message.sender_user_id = $2
         AND message.client_message_id = $3
       LIMIT 1`,
      [conversationId, userId, clientMessageId],
    );
    const row = result.rows[0];
    return row === undefined ? null : mapMessage(row);
  }

  private async loadMessageById(
    client: PoolClient,
    messageId: string,
  ): Promise<ChatMessageSnapshot | null> {
    const result = await client.query<MessageRow>(
      `${MESSAGE_SELECT}
       WHERE message.id = $1
       LIMIT 1`,
      [messageId],
    );
    const row = result.rows[0];
    return row === undefined ? null : mapMessage(row);
  }
}
