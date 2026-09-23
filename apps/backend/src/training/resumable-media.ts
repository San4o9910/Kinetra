import { createWriteStream } from 'node:fs';
import { mkdir, open, rm, stat, statfs, rename, chmod } from 'node:fs/promises';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { Request, Response } from 'express';
import { type TrainingMedia } from './media.js';
import { trainingId, trainingError } from './service.js';
const execute = promisify(execFile);
const CHUNK = 4 * 1024 ** 2,
  MAX = 256 * 1024 ** 2;
export class ResumableTrainingMedia {
  private running: Promise<void> | null = null;
  private abort: AbortController | null = null;
  public constructor(public readonly media: TrainingMedia) {}
  private path(id: string, suffix: string) {
    if (!this.media.directory)
      trainingError(503, 'MEDIA_UNAVAILABLE', 'Загрузка временно недоступна.');
    return join(this.media.directory, trainingId(id) + suffix);
  }
  public async status(user: string, id: string) {
    await this.media.service.trainer(this.media.service.pool, user);
    const r = await this.media.service.pool.query(
      'SELECT status,upload_offset::float8 AS offset,source_bytes::float8 AS size,original_name,source_modified::float8,error_message FROM training_lessons WHERE id=$1 AND trainer_id=$2',
      [trainingId(id), user],
    );
    if (!r.rows[0]) trainingError(404, 'LESSON_UNAVAILABLE', 'Урок недоступен.');
    return { ...r.rows[0], chunk_bytes: CHUNK };
  }
  public async chunk(user: string, id: string, req: Request) {
    trainingId(id);
    if (req.get('content-type')?.split(';')[0] !== 'application/octet-stream')
      trainingError(415, 'CHUNK_TYPE', 'Не удалось прочитать фрагмент видео.');
    const length = Number(req.get('content-length')),
      offset = Number(req.get('x-upload-offset'));
    if (
      !Number.isSafeInteger(length) ||
      length < 1 ||
      length > CHUNK ||
      !Number.isSafeInteger(offset) ||
      offset < 0
    )
      trainingError(400, 'CHUNK_SIZE', 'Некорректный фрагмент видео.');
    return this.media.service.transaction(async (db) => {
      await this.media.service.trainer(db, user);
      const r = await db.query(
        'SELECT * FROM training_lessons WHERE id=$1 AND trainer_id=$2 FOR UPDATE',
        [id, user],
      );
      const row = r.rows[0];
      if (!row || !['pending', 'uploading'].includes(row.status))
        trainingError(409, 'UPLOAD_STATE', 'Загрузка уже завершена или отменена.');
      if (Number(row.upload_offset) !== offset || offset + length > Number(row.source_bytes))
        trainingError(409, 'UPLOAD_OFFSET', 'Уточните сохранённый объём и продолжите загрузку.');
      const target = this.path(id, '.upload');
      await mkdir(this.media.directory!, { recursive: true, mode: 0o700 });
      const disk = await statfs(this.media.directory!);
      if (disk.bavail * disk.bsize < length + MAX + 512 * 1024 ** 2)
        trainingError(507, 'MEDIA_DISK_FULL', 'Недостаточно места для видео.');
      const handle = await open(target, offset === 0 ? 'w' : 'r+', 0o600);
      try {
        const current = await handle.stat();
        if (current.size < offset)
          trainingError(409, 'UPLOAD_FILE_LOST', 'Загрузите видео заново.');
        await handle.truncate(offset);
      } finally {
        await handle.close();
      }
      const controller = new AbortController(),
        timer = setTimeout(() => controller.abort(), 90_000);
      let received = 0;
      try {
        await pipeline(
          req,
          new Transform({
            transform(chunk: Buffer, _encoding, done) {
              received += chunk.length;
              done(received > length ? new Error('CHUNK_SIZE') : null, chunk);
            },
          }),
          createWriteStream(target, { flags: 'r+', start: offset }),
          { signal: controller.signal },
        );
        if (received !== length)
          trainingError(400, 'CHUNK_INCOMPLETE', 'Связь прервалась. Повторите фрагмент.');
        const f = await open(target, 'r+');
        try {
          await f.sync();
        } finally {
          await f.close();
        }
        await db.query(
          "UPDATE training_lessons SET status='uploading',upload_offset=$2,updated_at=now() WHERE id=$1",
          [id, offset + received],
        );
        return { offset: offset + received };
      } finally {
        clearTimeout(timer);
      }
    });
  }
  public async finish(user: string, id: string) {
    await this.media.service.transaction(async (db) => {
      await this.media.service.trainer(db, user);
      const r = await db.query(
        'SELECT * FROM training_lessons WHERE id=$1 AND trainer_id=$2 FOR UPDATE',
        [trainingId(id), user],
      );
      const row = r.rows[0];
      if (row?.status === 'ready' || row?.status === 'processing') return;
      if (
        !row ||
        row.status !== 'uploading' ||
        Number(row.upload_offset) !== Number(row.source_bytes)
      )
        trainingError(409, 'UPLOAD_INCOMPLETE', 'Видео ещё не загрузилось полностью.');
      const f = await stat(this.path(id, '.upload')).catch(() => null);
      if (f?.size !== Number(row.source_bytes))
        trainingError(409, 'UPLOAD_INCOMPLETE', 'Повторите загрузку видео.');
      await db.query(
        "UPDATE training_lessons SET status='processing',processing_started_at=NULL,updated_at=now(),error_message='' WHERE id=$1",
        [id],
      );
    });
    void this.processNext();
    return { queued: true };
  }
  public async cancel(user: string, id: string) {
    await this.media.service.transaction(async (db) => {
      await this.media.service.trainer(db, user);
      const r = await db.query(
        'SELECT status FROM training_lessons WHERE id=$1 AND trainer_id=$2 FOR UPDATE',
        [trainingId(id), user],
      );
      if (!r.rows[0] || !['pending', 'uploading', 'failed'].includes(r.rows[0].status))
        trainingError(409, 'UPLOAD_STATE', 'Готовое или обрабатываемое видео нельзя отменить.');
      await db.query(
        "UPDATE training_lessons SET status='failed',error_message='Загрузка отменена',updated_at=now() WHERE id=$1",
        [id],
      );
      await rm(this.path(id, '.upload'), { force: true });
    });
    return { saved: true };
  }
  public processNext(): Promise<void> {
    if (this.running) return this.running;
    this.running = this.process()
      .catch(() => {
        console.error('Training media processing failed; retry is scheduled.');
      })
      .finally(() => {
        this.running = null;
      });
    return this.running;
  }
  public async stop() {
    this.abort?.abort();
    await this.running;
  }
  private async process() {
    if (!this.media.directory) return;
    const db = await this.media.service.pool.connect();
    let locked = false;
    try {
      locked = (
        await db.query("SELECT pg_try_advisory_lock(hashtext('training-video-worker')) locked")
      ).rows[0].locked;
      if (!locked) return;
      await this.media.cleanup();
      const next = await db.query(
        "SELECT l.id,l.trainer_id FROM training_lessons l JOIN trainer_profiles t ON t.user_id=l.trainer_id WHERE l.status='processing' AND t.is_active ORDER BY l.updated_at LIMIT 1",
      );
      const row = next.rows[0];
      if (!row) return;
      const id = row.id as string,
        input = this.path(id, '.upload'),
        output = this.path(id, '.processing.mp4'),
        thumb = this.path(id, '.thumb.jpg');
      this.abort = new AbortController();
      const controller = this.abort;
      const options = {
        timeout: 30_000,
        maxBuffer: 256 * 1024,
        killSignal: 'SIGKILL' as const,
        signal: controller.signal,
      };
      await db.query(
        'UPDATE training_lessons SET processing_started_at=now(),updated_at=now() WHERE id=$1',
        [id],
      );
      let committed = false;
      try {
        const probe = JSON.parse(
          (
            await execute(
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
                input,
              ],
              options,
            )
          ).stdout,
        ) as {
          format?: { format_name?: string; duration?: string };
          streams?: { codec_type?: string; codec_name?: string; width?: number; height?: number }[];
        };
        const videos = probe.streams?.filter((s) => s.codec_type === 'video') ?? [],
          audio = probe.streams?.filter((s) => s.codec_type === 'audio') ?? [];
        const duration = Number(probe.format?.duration);
        if (
          !probe.format?.format_name
            ?.split(',')
            .some((n) => ['mov', 'mp4', 'matroska', 'webm'].includes(n)) ||
          videos.length !== 1 ||
          !['h264', 'hevc', 'vp8', 'vp9', 'av1', 'mpeg4'].includes(videos[0]?.codec_name ?? '') ||
          !videos[0]?.width ||
          !videos[0]?.height ||
          videos[0].width > 3840 ||
          videos[0].height > 3840 ||
          audio.length > 1 ||
          !Number.isFinite(duration) ||
          duration <= 0 ||
          duration > 7200 ||
          probe.streams?.some((s) => !['video', 'audio', 'data'].includes(s.codec_type ?? ''))
        )
          trainingError(
            415,
            'VIDEO_FORMAT',
            'Выберите обычное видео MP4, MOV или WebM, до 2 часов и 4K.',
          );
        await rm(output, { force: true });
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
            input,
            '-map',
            '0:v:0',
            '-map',
            '0:a:0?',
            '-map_metadata',
            '-1',
            '-map_chapters',
            '-1',
            '-vf',
            'scale=1280:1280:force_original_aspect_ratio=decrease:force_divisible_by=2,format=yuv420p',
            '-c:v',
            'libx264',
            '-preset',
            'veryfast',
            '-crf',
            '25',
            '-threads',
            '1',
            '-filter_threads',
            '1',
            '-r',
            '30',
            '-c:a',
            'aac',
            '-b:a',
            '96k',
            '-ac',
            '2',
            '-movflags',
            '+faststart',
            '-fs',
            String(MAX),
            output,
          ],
          { ...options, timeout: 30 * 60_000, maxBuffer: 128 * 1024 },
        );
        const final = JSON.parse(
          (
            await execute(
              'ffprobe',
              ['-v', 'error', '-protocol_whitelist', 'file', '-show_format', '-of', 'json', output],
              options,
            )
          ).stdout,
        ) as { format?: { duration?: string } };
        const size = (await stat(output)).size;
        if (size > MAX || size < 1 || Math.abs(Number(final.format?.duration) - duration) > 2)
          trainingError(
            415,
            'VIDEO_TOO_LARGE',
            'Видео слишком длинное для выбранного размера. Разделите его на несколько уроков.',
          );
        await execute(
          'ffmpeg',
          [
            '-v',
            'error',
            '-nostdin',
            '-protocol_whitelist',
            'file',
            '-threads',
            '1',
            '-i',
            output,
            '-frames:v',
            '1',
            '-vf',
            'scale=480:-2',
            '-update',
            '1',
            '-y',
            thumb,
          ],
          options,
        );
        await chmod(output, 0o600);
        await chmod(thumb, 0o600);
        await this.media.service.transaction(async (transaction) => {
          await this.media.service.trainer(transaction, row.trainer_id);
          const current = await transaction.query(
            "SELECT id FROM training_lessons WHERE id=$1 AND status='processing' FOR UPDATE",
            [id],
          );
          if (current.rowCount !== 1)
            trainingError(409, 'UPLOAD_STATE', 'Загрузка больше не активна.');
          await rename(output, this.media.path(id));
          await transaction.query(
            "UPDATE training_lessons SET status='ready',size_bytes=$2,duration_seconds=$3,thumbnail_ready=true,error_message='',updated_at=now() WHERE id=$1",
            [id, size, Math.ceil(duration)],
          );
        });
        committed = true;
        await rm(input, { force: true });
      } catch (error) {
        if (committed) return;
        await rm(output, { force: true });
        await rm(thumb, { force: true });
        if (!controller.signal.aborted) {
          await db.query(
            "UPDATE training_lessons SET status='failed',error_message=$2,updated_at=now() WHERE id=$1 AND status='processing'",
            [
              id,
              error instanceof Error && 'statusCode' in error
                ? error.message
                : 'Не удалось подготовить видео. Попробуйте другой файл или более короткий урок.',
            ],
          );
          await rm(input, { force: true });
          await rm(this.media.path(id), { force: true });
        }
      } finally {
        this.abort = null;
      }
    } finally {
      if (locked)
        await db
          .query("SELECT pg_advisory_unlock(hashtext('training-video-worker'))")
          .catch(() => {});
      db.release();
    }
  }
  public async thumbnail(req: Request, res: Response, id: string) {
    const user = this.media.verify(req.query.token, id);
    await this.media.service.mediaAccess(user, id);
    const file = this.path(id, '.thumb.jpg');
    const f = await stat(file).catch(() => null);
    if (!f) trainingError(404, 'THUMBNAIL_UNAVAILABLE', 'Обложка ещё не готова.');
    res.set({
      'Content-Type': 'image/jpeg',
      'Cache-Control': 'private, no-store',
      'Content-Length': String(f.size),
    });
    res.sendFile(file);
  }
}
