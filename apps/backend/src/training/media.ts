import { createHmac, timingSafeEqual, randomUUID } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir, readdir, rename, rm, stat, statfs } from 'node:fs/promises';
import { join, isAbsolute } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { Request, Response } from 'express';
import { type TrainingService, trainingError, trainingId } from './service.js';
const execute = promisify(execFile);
export const parseMediaRange = (
  value: string | undefined,
  size: number,
): { start: number; end: number } | null => {
  if (!value) return { start: 0, end: size - 1 };
  const match = /^bytes=(\d*)-(\d*)$/u.exec(value);
  if (!match || (!match[1] && !match[2])) return null;
  const suffix = !match[1];
  const start = suffix ? Math.max(0, size - Number(match[2])) : Number(match[1]);
  const end = suffix ? size - 1 : match[2] ? Math.min(Number(match[2]), size - 1) : size - 1;
  return Number.isSafeInteger(start) &&
    Number.isSafeInteger(end) &&
    start >= 0 &&
    start < size &&
    end >= start
    ? { start, end }
    : null;
};
export class TrainingMedia {
  public constructor(
    public readonly service: TrainingService,
    public readonly directory: string | null,
    public readonly secret: string,
  ) {
    if (directory && !isAbsolute(directory))
      throw new Error('TRAINING_MEDIA_DIR must be an absolute private persistent path.');
  }
  public path(id: string) {
    return join(this.directory!, `${trainingId(id)}.mp4`);
  }
  public sign(user: string, id: string, now = Date.now()): string {
    const payload = Buffer.from(
      JSON.stringify({ user, id, expires: Math.floor(now / 1000) + 300 }),
    ).toString('base64url');
    return `${payload}.${createHmac('sha256', this.secret).update(`training-media:${payload}`).digest('base64url')}`;
  }
  public verify(token: unknown, id: string, now = Date.now()): string {
    if (typeof token !== 'string' || token.length > 600)
      return trainingError(401, 'MEDIA_EXPIRED', 'Обновите ссылку на видео.');
    const [payload, mac, ...rest] = token.split('.');
    if (!payload || !mac || rest.length)
      return trainingError(401, 'MEDIA_EXPIRED', 'Обновите ссылку на видео.');
    const expected = createHmac('sha256', this.secret).update(`training-media:${payload}`).digest();
    const actual = Buffer.from(mac, 'base64url');
    if (actual.length !== expected.length || !timingSafeEqual(actual, expected))
      return trainingError(401, 'MEDIA_EXPIRED', 'Обновите ссылку на видео.');
    let value: { user?: unknown; id?: unknown; expires?: unknown };
    try {
      value = JSON.parse(Buffer.from(payload, 'base64url').toString()) as typeof value;
    } catch {
      return trainingError(401, 'MEDIA_EXPIRED', 'Обновите ссылку на видео.');
    }
    if (
      value.id !== id ||
      typeof value.user !== 'string' ||
      typeof value.expires !== 'number' ||
      value.expires <= Math.floor(now / 1000) ||
      value.expires > Math.floor(now / 1000) + 300
    )
      return trainingError(401, 'MEDIA_EXPIRED', 'Обновите ссылку на видео.');
    return trainingId(value.user);
  }
  public async access(user: string, id: string) {
    if (!this.directory) trainingError(503, 'MEDIA_UNAVAILABLE', 'Видео временно недоступно.');
    await this.service.mediaAccess(user, id);
    return { path: `/api/v1/training/media/${id}?token=${this.sign(user, id)}` };
  }
  public async stream(request: Request, response: Response, id: string) {
    if (!this.directory) trainingError(503, 'MEDIA_UNAVAILABLE', 'Видео временно недоступно.');
    const user = this.verify(request.query.token, id);
    const lesson = await this.service.mediaAccess(user, id);
    const file = await stat(this.path(id)).catch(() => null);
    if (!file || file.size !== lesson.size_bytes)
      trainingError(503, 'MEDIA_UNAVAILABLE', 'Видео временно недоступно. Повторите позже.');
    const range = parseMediaRange(request.get('range'), file.size);
    if (!range) {
      response.status(416).set('Content-Range', `bytes */${file.size}`).end();
      return;
    }
    response.status(request.get('range') ? 206 : 200).set({
      'Content-Type': 'video/mp4',
      'Accept-Ranges': 'bytes',
      'Content-Length': String(range.end - range.start + 1),
      'Cache-Control': 'private, no-store',
      'Content-Disposition': 'inline',
    });
    if (request.get('range'))
      response.set('Content-Range', `bytes ${range.start}-${range.end}/${file.size}`);
    if (request.method === 'HEAD') {
      response.end();
      return;
    }
    const stream = createReadStream(this.path(id), range);
    response.once('close', () => stream.destroy());
    await pipeline(stream, response);
  }
  public async cleanup(): Promise<void> {
    if (!this.directory) return;
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    await this.service.pool.query(
      "UPDATE training_lessons SET status='failed',updated_at=now() WHERE status IN ('pending','uploading') AND ((original_name='' AND updated_at<now()-interval '30 minutes') OR updated_at<now()-interval '24 hours')",
    );
    const rows = await this.service.pool.query(
      "SELECT id,status FROM training_lessons WHERE status IN ('ready','uploading','pending','processing')",
    );
    const live = new Map(rows.rows.map((r) => [r.id as string, r.status as string]));
    const photos = new Set(
      (
        await this.service.pool.query(
          'SELECT photo_id FROM training_measurements WHERE photo_id IS NOT NULL',
        )
      ).rows.map((r) => r.photo_id as string),
    );
    for (const name of await readdir(this.directory)) {
      const lesson =
        /^([0-9a-f-]{36})(\.[0-9a-f-]{36}\.part|\.mp4|\.upload|\.processing\.mp4|\.thumb\.jpg)$/u.exec(
          name,
        );
      const photo = /^progress-([0-9a-f-]{36})(\.input|\.jpg)$/u.exec(name);
      if (!lesson && !photo) continue;
      const path = join(this.directory, name);
      const file = await stat(path).catch(() => null);
      if (!file || Date.now() - file.mtimeMs < 60 * 60_000) continue;
      const abandoned = lesson
        ? !live.has(lesson[1]!) ||
          (live.get(lesson[1]!) === 'ready' &&
            ['.upload', '.processing.mp4'].includes(lesson[2]!)) ||
          lesson[2]!.endsWith('.part')
        : photo![2] === '.input' || !photos.has(photo![1]!);
      if (abandoned) await rm(path, { force: true });
    }
  }

  public async upload(trainer: string, id: string, request: Request) {
    if (!this.directory)
      trainingError(503, 'MEDIA_UNAVAILABLE', 'Загрузка видео временно недоступна.');
    trainingId(id);
    if (request.get('content-type')?.split(';')[0] !== 'video/mp4')
      trainingError(415, 'MP4_REQUIRED', 'Выберите видео MP4 (H.264).');
    await this.service.trainer(this.service.pool, trainer);
    await this.cleanup();
    const size = Number(request.get('content-length'));
    const target = this.path(id);
    const temporary = join(this.directory!, `${id}.${randomUUID()}.part`);
    const expected = await this.service.transaction(async (db) => {
      await this.service.trainer(db, trainer);
      await db.query("SELECT pg_advisory_xact_lock(hashtext('training-media-quota'))");
      const result = await db.query(
        'SELECT * FROM training_lessons WHERE id=$1 AND trainer_id=$2 FOR UPDATE',
        [id, trainer],
      );
      const row = result.rows[0];
      if (!row || !['pending', 'failed'].includes(row.status))
        trainingError(409, 'UPLOAD_STATE', 'Создайте новую загрузку или обновите список уроков.');
      if (!Number.isSafeInteger(size) || size !== Number(row.size_bytes))
        trainingError(400, 'VIDEO_SIZE', 'Размер видео изменился. Создайте новую загрузку.');
      const busy = await db.query(
        "SELECT id FROM training_lessons WHERE status='uploading' LIMIT 1",
      );
      if (busy.rowCount !== 0)
        trainingError(
          429,
          'UPLOAD_BUSY',
          'Сейчас обрабатывается другое видео. Повторите через минуту.',
        );
      const quota = await db.query(
        "SELECT COALESCE(sum(CASE WHEN status='ready' THEN size_bytes ELSE 268435456 END),0)::float8 total,COALESCE(sum(CASE WHEN status='ready' THEN size_bytes ELSE 268435456 END) FILTER(WHERE trainer_id=$1),0)::float8 own FROM training_lessons WHERE status IN ('ready','pending','uploading','processing') AND id<>$2",
        [trainer, id],
      );
      if (quota.rows[0].total + size > 5 * 1024 ** 3 || quota.rows[0].own + size > 1024 ** 3)
        trainingError(409, 'MEDIA_QUOTA', 'Недостаточно места для урока.');
      const disk = await statfs(this.directory!);
      if (disk.bavail * disk.bsize < size + 512 * 1024 ** 2)
        trainingError(507, 'MEDIA_DISK_FULL', 'Хранилище заполнено. Попробуйте позже.');
      await db.query(
        "UPDATE training_lessons SET status='uploading',updated_at=now() WHERE id=$1",
        [id],
      );
      return size;
    });
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 10 * 60_000);
    let received = 0;
    try {
      await pipeline(
        request,
        new Transform({
          transform(chunk: Buffer, _encoding, done) {
            received += chunk.length;
            done(received > expected ? new Error('VIDEO_SIZE') : null, chunk);
          },
        }),
        createWriteStream(temporary, { flags: 'wx', mode: 0o600 }),
        { signal: controller.signal },
      );
      if (received !== expected)
        trainingError(400, 'VIDEO_SIZE', 'Видео загрузилось не полностью. Повторите загрузку.');
      const result = await execute(
        'ffprobe',
        [
          '-v',
          'error',
          '-protocol_whitelist',
          'file',
          '-show_format',
          '-show_streams',
          '-of',
          'json',
          temporary,
        ],
        {
          timeout: 30_000,
          maxBuffer: 256 * 1024,
          killSignal: 'SIGKILL',
          signal: controller.signal,
        },
      );
      const metadata = JSON.parse(result.stdout) as {
        format?: { format_name?: string; duration?: string };
        streams?: {
          codec_type?: string;
          codec_name?: string;
          width?: number;
          height?: number;
          pix_fmt?: string;
        }[];
      };
      const videos = metadata.streams?.filter((s) => s.codec_type === 'video') ?? [];
      const audio = metadata.streams?.filter((s) => s.codec_type === 'audio') ?? [];
      const duration = Number(metadata.format?.duration);
      if (
        !metadata.format?.format_name?.split(',').includes('mp4') ||
        videos.length !== 1 ||
        videos[0]?.codec_name !== 'h264' ||
        videos[0]?.pix_fmt !== 'yuv420p' ||
        !videos[0]?.width ||
        !videos[0]?.height ||
        videos[0].width > 3840 ||
        videos[0].height > 3840 ||
        audio.length > 1 ||
        audio.some((s) => s.codec_name !== 'aac') ||
        metadata.streams?.some((s) => !['video', 'audio'].includes(s.codec_type ?? '')) ||
        !Number.isFinite(duration) ||
        duration <= 0 ||
        duration > 7200
      )
        trainingError(
          415,
          'VIDEO_FORMAT',
          'Поддерживается MP4 с видео H.264 и звуком AAC, до 2 часов и 4K. Экспортируйте видео в этом формате.',
        );
      // Decode a bounded sample: probe success alone is insufficient for an empty/corrupt file.
      await execute(
        'ffmpeg',
        [
          '-v',
          'error',
          '-xerror',
          '-nostdin',
          '-protocol_whitelist',
          'file',
          '-threads',
          '1',
          '-i',
          temporary,
          '-t',
          '2',
          '-f',
          'null',
          '-',
        ],
        { timeout: 30_000, maxBuffer: 64 * 1024, killSignal: 'SIGKILL', signal: controller.signal },
      );
      await rename(temporary, target);
      await this.service.transaction(async (db) => {
        await this.service.trainer(db, trainer);
        const updated = await db.query(
          "UPDATE training_lessons SET status='ready',duration_seconds=$3,updated_at=now() WHERE id=$1 AND trainer_id=$2 AND status='uploading' RETURNING id",
          [id, trainer, Math.ceil(duration)],
        );
        if (updated.rowCount !== 1)
          trainingError(409, 'UPLOAD_STATE', 'Загрузка больше не активна.');
      });
      return { saved: true };
    } catch (error) {
      await rm(target, { force: true });
      await this.service.pool.query(
        "UPDATE training_lessons SET status='failed',updated_at=now() WHERE id=$1 AND status='uploading'",
        [id],
      );
      if (error instanceof Error && 'statusCode' in error) throw error;
      return trainingError(
        400,
        'VIDEO_UPLOAD_FAILED',
        'Видео не удалось загрузить или проверить. Повторите загрузку MP4 (H.264).',
      );
    } finally {
      clearTimeout(timer);
      await rm(temporary, { force: true });
    }
  }
  public async remove(trainer: string, id: string) {
    const result = await this.service.removeLesson(trainer, id);
    if (this.directory)
      for (const suffix of ['.mp4', '.thumb.jpg', '.upload', '.processing.mp4'])
        await rm(join(this.directory, `${id}${suffix}`), { force: true });
    return result;
  }
}
