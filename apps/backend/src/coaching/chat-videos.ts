import { GetObjectCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import express, { Router, type RequestHandler } from 'express';
import type { Pool, PoolClient } from 'pg';
import { HttpError } from '../auth/errors.js';
import { requireAuthenticatedPrincipal } from '../auth/middleware.js';
import { createFixedWindowRateLimiter } from '../auth/rate-limit.js';
import type { ChatRuntime } from '../chat/runtime.js';
import type { S3Environment } from '../config/env.js';
import { workoutKeySchema } from './schema.js';

const execute = promisify(execFile);
const limit = 32 * 1024 * 1024;

export const normalizeChatVideo = async (
  input: Buffer,
  directory: string,
): Promise<{ data: Buffer; duration: number }> => {
  const source = join(directory, 'input');
  const target = join(directory, 'output.mp4');
  await writeFile(source, input, { mode: 0o600 });
  const probe = await execute(
    'ffprobe',
    [
      '-v',
      'error',
      '-protocol_whitelist',
      'file,pipe',
      '-f',
      'mov',
      '-show_streams',
      '-show_format',
      '-of',
      'json',
      source,
    ],
    { timeout: 15_000, maxBuffer: 128_000 },
  );
  const metadata = JSON.parse(probe.stdout) as {
    format?: { duration?: string };
    streams?: {
      codec_type?: string;
      width?: number;
      height?: number;
      disposition?: { attached_pic?: number };
    }[];
  };
  const videos = metadata.streams?.filter((stream) => stream.codec_type === 'video') ?? [];
  const duration = Number(metadata.format?.duration);
  if (
    videos.length !== 1 ||
    videos[0]?.disposition?.attached_pic === 1 ||
    !Number.isFinite(duration) ||
    duration <= 0 ||
    duration > 180 ||
    (videos[0]?.width ?? 0) > 3840 ||
    (videos[0]?.height ?? 0) > 3840 ||
    (videos[0]?.width ?? 0) < 16 ||
    (videos[0]?.height ?? 0) < 16 ||
    (metadata.streams?.filter((stream) => stream.codec_type === 'audio').length ?? 0) > 1 ||
    metadata.streams?.some(
      (stream) => stream.codec_type !== 'video' && stream.codec_type !== 'audio',
    )
  )
    throw new HttpError(400, 'INVALID_CHAT_VIDEO', 'Нужно обычное видео до 3 минут и до 4K.');
  await execute(
    'ffmpeg',
    [
      '-v',
      'error',
      '-nostdin',
      '-threads',
      '2',
      '-protocol_whitelist',
      'file,pipe',
      '-f',
      'mov',
      '-i',
      source,
      '-map',
      '0:v:0',
      '-map',
      '0:a:0?',
      '-map_metadata',
      '-1',
      '-map_chapters',
      '-1',
      '-vf',
      "scale=w='min(1280,iw)':h='min(1280,ih)':force_original_aspect_ratio=decrease:force_divisible_by=2",
      '-c:v',
      'libx264',
      '-threads',
      '2',
      '-preset',
      'veryfast',
      '-crf',
      '26',
      '-pix_fmt',
      'yuv420p',
      '-c:a',
      'aac',
      '-b:a',
      '96k',
      '-movflags',
      '+faststart',
      '-fs',
      String(limit),
      '-y',
      target,
    ],
    { timeout: 90_000, maxBuffer: 64_000 },
  );
  const data = await readFile(target);
  if (data.length === 0 || data.length >= limit)
    throw new HttpError(413, 'CHAT_VIDEO_TOO_LARGE', 'Выберите более короткое видео.');
  const outputProbe = await execute(
    'ffprobe',
    ['-v', 'error', '-show_entries', 'format=duration', '-of', 'json', target],
    { timeout: 15_000, maxBuffer: 16_000 },
  );
  const outputDuration = Number(
    (JSON.parse(outputProbe.stdout) as { format?: { duration?: string } }).format?.duration,
  );
  if (!Number.isFinite(outputDuration) || outputDuration + 1 < duration)
    throw new HttpError(413, 'CHAT_VIDEO_TOO_LARGE', 'Выберите более короткое видео.');
  return { data, duration: Math.min(180, Math.ceil(outputDuration)) };
};

export const createChatVideosRouter = (
  pool: Pool,
  runtime: ChatRuntime,
  config: S3Environment | null,
  enabled: boolean,
): Router => {
  const router = Router();
  const s3 =
    config === null
      ? null
      : new S3Client({
          region: config.region,
          credentials: { accessKeyId: config.accessKeyId, secretAccessKey: config.secretAccessKey },
          forcePathStyle: config.forcePathStyle,
          ...(config.endpoint === null ? {} : { endpoint: config.endpoint }),
        });
  const available = enabled && s3 !== null;
  let uploads = 0;
  const requireAccess = async (userId: string, conversationId: string): Promise<void> => {
    if (!workoutKeySchema.shape.video_id.safeParse(conversationId).success)
      throw new HttpError(400, 'INVALID_CONVERSATION', 'Некорректный диалог.');
    const found = await pool.query(
      `SELECT 1 FROM chat_conversations c JOIN trainer_profiles t ON t.user_id=c.trainer_user_id JOIN users u ON u.id=c.client_user_id WHERE c.id=$1 AND (c.client_user_id=$2 OR c.trainer_user_id=$2) AND t.is_active=true AND u.onboarding_status='active'`,
      [conversationId, userId],
    );
    if (found.rowCount !== 1)
      throw new HttpError(403, 'CONVERSATION_ACCESS_REQUIRED', 'Этот диалог недоступен.');
  };
  router.use(runtime.authMiddleware);
  router.use((_request, response, next) => {
    response.setHeader('Cache-Control', 'no-store');
    response.setHeader('Referrer-Policy', 'no-referrer');
    next();
  });
  router.get('/:conversationId', async (request, response, next) => {
    try {
      const { userId } = requireAuthenticatedPrincipal(request);
      await requireAccess(userId, request.params.conversationId);
      if (!available || config === null || s3 === null) {
        response.json({ available: false, videos: [] });
        return;
      }
      const result = await pool.query(
        "SELECT id,uploader_user_id,object_key,duration_seconds,created_at FROM chat_video_assets WHERE conversation_id=$1 AND status='ready' ORDER BY created_at DESC LIMIT 30",
        [request.params.conversationId],
      );
      const videos = await Promise.all(
        result.rows.map(async (row) => ({
          id: row.id,
          uploader_user_id: row.uploader_user_id,
          duration_seconds: row.duration_seconds,
          created_at: row.created_at,
          url: await getSignedUrl(
            s3,
            new GetObjectCommand({
              Bucket: config.bucket,
              Key: row.object_key as string,
              ResponseContentType: 'video/mp4',
              ResponseCacheControl: 'private, no-store',
              ResponseContentDisposition: 'inline',
            }),
            { expiresIn: 300 },
          ),
        })),
      );
      await requireAccess(userId, request.params.conversationId);
      response.json({ available: true, videos });
    } catch (error) {
      next(error);
    }
  });
  const admit: RequestHandler = (request, response, next) => {
    if (!available) {
      next(new HttpError(503, 'CHAT_VIDEO_UNAVAILABLE', 'Отправка видео пока недоступна.'));
      return;
    }
    if (
      !['video/mp4', 'video/quicktime'].includes(request.get('content-type') ?? '') ||
      !workoutKeySchema.shape.video_id.safeParse(request.get('x-upload-id')).success
    ) {
      next(new HttpError(400, 'INVALID_CHAT_VIDEO', 'Выберите MP4 или MOV.'));
      return;
    }
    const length = Number(request.get('content-length'));
    if (!Number.isSafeInteger(length) || length <= 0 || length > limit) {
      next(new HttpError(413, 'CHAT_VIDEO_TOO_LARGE', 'Максимальный размер видео — 32 МБ.'));
      return;
    }
    const { userId } = requireAuthenticatedPrincipal(request);
    void requireAccess(userId, String(request.params.conversationId))
      .then(() => {
        if (uploads >= 2) {
          next(
            new HttpError(
              429,
              'CHAT_VIDEO_BUSY',
              'Сервис обрабатывает другие видео. Повторите немного позже.',
            ),
          );
          return;
        }
        uploads += 1;
        let released = false;
        const release = (): void => {
          if (!released) {
            released = true;
            uploads -= 1;
          }
        };
        response.locals.releaseVideoSlot = release;
        response.once('finish', release);
        request.once('aborted', release);
        const deadline = setTimeout(() => {
          if (!request.complete) {
            request.destroy();
            release();
          }
        }, 90_000);
        response.locals.videoBodyDeadline = deadline;
        response.once('close', () => {
          clearTimeout(deadline);
          if (!request.complete) release();
        });
        // A body timeout bounds slow senders; processing retains its slot until finally.
        request.setTimeout(30_000, () => {
          request.destroy();
          release();
        });
        next();
      })
      .catch(next);
  };
  router.post(
    '/:conversationId',
    createFixedWindowRateLimiter({
      windowMs: 900_000,
      maximumRequests: 10,
      errorMessage: 'Подождите перед отправкой следующего видео.',
    }),
    admit,
    express.raw({ type: ['video/mp4', 'video/quicktime'], limit, inflate: false }),
    async (request, response, next) => {
      request.setTimeout(0);
      clearTimeout(response.locals.videoBodyDeadline as ReturnType<typeof setTimeout>);
      const { userId, sessionId } = requireAuthenticatedPrincipal(request);
      const conversationId = String(request.params.conversationId);
      const id = request.get('x-upload-id')!;
      let directory: string | null = null;
      let created = false;
      let lease: PoolClient | null = null;
      const key = `chat/videos/${conversationId}/${id}.mp4`;
      try {
        if (s3 === null || config === null || !Buffer.isBuffer(request.body))
          throw new HttpError(400, 'INVALID_CHAT_VIDEO', 'Видео не получено.');
        const previous = await pool.query(
          'SELECT status FROM chat_video_assets WHERE id=$1 AND conversation_id=$2 AND uploader_user_id=$3',
          [id, conversationId, userId],
        );
        if (previous.rows[0]?.status === 'uploading')
          throw new HttpError(409, 'CHAT_VIDEO_PROCESSING', 'Это видео ещё обрабатывается.');
        if (previous.rows[0]?.status !== 'ready') {
          await pool.query(
            "INSERT INTO chat_video_assets(id,conversation_id,uploader_user_id,object_key,status) VALUES($1,$2,$3,$4,'uploading')",
            [id, conversationId, userId, key],
          );
          created = true;
          directory = await mkdtemp(join(tmpdir(), 'kinetra-chat-video-'));
          const normalized = await normalizeChatVideo(request.body, directory);
          await requireAccess(userId, conversationId);
          lease = await pool.connect();
          await lease.query('SELECT pg_advisory_lock(hashtextextended($1,0))', [key]);
          await requireAccess(userId, conversationId);
          await s3.send(
            new PutObjectCommand({
              Bucket: config.bucket,
              Key: key,
              Body: normalized.data,
              ContentType: 'video/mp4',
              CacheControl: 'private, no-store',
              ServerSideEncryption: 'AES256',
            }),
            { abortSignal: AbortSignal.timeout(30_000) },
          );
          const updated = await pool.query(
            "UPDATE chat_video_assets SET status='ready',duration_seconds=$2,size_bytes=$3 WHERE id=$1",
            [id, normalized.duration, normalized.data.length],
          );
          if (updated.rowCount !== 1)
            throw new HttpError(409, 'CHAT_VIDEO_CANCELLED', 'Отправка отменена.');
        }
        await runtime.service.sendMessage(
          { userId, sessionId, ip: request.ip ?? 'unknown' },
          conversationId,
          {
            client_message_id: id,
            kind: 'text',
            text: 'Отправлено видео для проверки. Откройте «Видео в диалоге».',
          },
        );
        response.status(201).json({ id });
      } catch (error) {
        if (created)
          await pool
            .query("DELETE FROM chat_video_assets WHERE id=$1 AND status='uploading'", [id])
            .catch(() => undefined);
        next(
          error instanceof HttpError
            ? error
            : new HttpError(
                400,
                'CHAT_VIDEO_FAILED',
                'Не удалось обработать видео. Выберите MP4 или MOV до 32 МБ и 3 минут.',
              ),
        );
      } finally {
        if (lease !== null) {
          try {
            await lease.query('SELECT pg_advisory_unlock(hashtextextended($1,0))', [key]);
            lease.release();
          } catch {
            lease.release(true);
          }
        }
        if (directory !== null)
          await rm(directory, { recursive: true, force: true }).catch(() => undefined);
        (response.locals.releaseVideoSlot as (() => void) | undefined)?.();
      }
    },
  );
  return router;
};
