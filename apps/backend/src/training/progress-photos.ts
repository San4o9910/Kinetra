import { randomUUID, createHmac, timingSafeEqual } from 'node:crypto';
import { join } from 'node:path';
import { writeFile, readFile, rm, mkdir, stat, statfs, chmod } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { Response } from 'express';
import { type TrainingMedia } from './media.js';
import { trainingId, trainingError } from './service.js';
const execute = promisify(execFile);
export class TrainingProgressPhotos {
  public constructor(private readonly media: TrainingMedia) {}
  private path(id: string, suffix = '.jpg') {
    if (!this.media.directory) trainingError(503, 'MEDIA_UNAVAILABLE', 'Фото временно недоступны.');
    return join(this.media.directory, 'progress-' + trainingId(id) + suffix);
  }
  private async permitted(user: string, id: string) {
    const r = await this.media.service.pool.query(
      `SELECT m.* FROM training_measurements m WHERE m.id=$1 AND (m.client_id=$2 OR (m.share_with_trainer AND EXISTS(SELECT 1 FROM training_students s JOIN trainer_profiles t ON t.user_id=s.trainer_id WHERE s.id=m.student_id AND s.trainer_id=$2 AND s.archived_at IS NULL AND t.is_active)))`,
      [trainingId(id), user],
    );
    if (!r.rows[0]) trainingError(404, 'MEASUREMENT_UNAVAILABLE', 'Запись недоступна.');
    return r.rows[0];
  }
  public async upload(user: string, id: string, bytes: unknown) {
    if (!Buffer.isBuffer(bytes) || bytes.length < 12 || bytes.length > 10 * 1024 ** 2)
      trainingError(400, 'PHOTO_SIZE', 'Выберите фото JPEG, PNG или WebP до 10 МБ.');
    // Decode only identified raster formats. Never accept SVG, PDF or delegated URL formats.
    const jpeg = bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255,
      png = bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])),
      webp = bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WEBP';
    if (!jpeg && !png && !webp)
      trainingError(415, 'PHOTO_FORMAT', 'Выберите фото JPEG, PNG или WebP.');
    return this.media.service.transaction(async (db) => {
      await db.query("SELECT pg_advisory_xact_lock(hashtext('training-progress-photos'))");
      const r = await db.query(
        'SELECT * FROM training_measurements WHERE id=$1 AND client_id=$2 FOR UPDATE',
        [trainingId(id), user],
      );
      if (!r.rows[0]) trainingError(404, 'MEASUREMENT_UNAVAILABLE', 'Запись недоступна.');
      if (r.rows[0].photo_id) trainingError(409, 'PHOTO_EXISTS', 'У записи уже есть фото.');
      const quota = await db.query(
        'SELECT COALESCE(sum(photo_bytes),0)::float8 total,COALESCE(sum(photo_bytes) FILTER(WHERE client_id=$1),0)::float8 own FROM training_measurements',
        [user],
      );
      if (
        quota.rows[0].own + 5 * 1024 ** 2 > 100 * 1024 ** 2 ||
        quota.rows[0].total + 5 * 1024 ** 2 > 500 * 1024 ** 2
      )
        trainingError(409, 'PHOTO_QUOTA', 'Удалите ненужные фотографии, чтобы освободить место.');
      const photo = randomUUID(),
        input = this.path(photo, '.input'),
        output = this.path(photo);
      await mkdir(this.media.directory!, { recursive: true, mode: 0o700 });
      const disk = await statfs(this.media.directory!);
      if (disk.bavail * disk.bsize < bytes.length + 512 * 1024 ** 2)
        trainingError(507, 'MEDIA_DISK_FULL', 'Недостаточно места.');
      try {
        await writeFile(input, bytes, { flag: 'wx', mode: 0o600 });
        await execute(
          'convert',
          [
            '-limit',
            'memory',
            '64MiB',
            '-limit',
            'map',
            '128MiB',
            '-limit',
            'disk',
            '128MiB',
            '-limit',
            'width',
            '12000',
            '-limit',
            'height',
            '12000',
            `${jpeg ? 'jpeg' : png ? 'png' : 'webp'}:${input}[0]`,
            '-auto-orient',
            '-resize',
            '1600x1600>',
            '-strip',
            '-quality',
            '82',
            `jpeg:${output}`,
          ],
          { timeout: 30_000, maxBuffer: 64 * 1024, killSignal: 'SIGKILL' },
        );
        await chmod(output, 0o600);
        const f = await stat(output);
        if (f.size < 1 || f.size > 5 * 1024 ** 2)
          trainingError(400, 'PHOTO_SIZE', 'Фото не удалось уменьшить.');
        await db.query('UPDATE training_measurements SET photo_id=$2,photo_bytes=$3 WHERE id=$1', [
          id,
          photo,
          f.size,
        ]);
        return { saved: true };
      } catch {
        await rm(output, { force: true });
        trainingError(400, 'PHOTO_INVALID', 'Фото не удалось прочитать. Выберите другой файл.');
      } finally {
        await rm(input, { force: true });
      }
    });
  }
  public async access(user: string, id: string) {
    const row = await this.permitted(user, id);
    if (!row.photo_id) trainingError(404, 'PHOTO_UNAVAILABLE', 'Фото не добавлено.');
    const expires = Math.floor(Date.now() / 1000) + 300;
    const payload = Buffer.from(JSON.stringify({ user, id, expires })).toString('base64url');
    const mac = createHmac('sha256', this.media.secret)
      .update('training-photo:' + payload)
      .digest('base64url');
    return { path: `/api/v1/training/progress-photos/${id}?token=${payload}.${mac}` };
  }
  public async stream(id: string, token: unknown, res: Response) {
    if (typeof token !== 'string' || token.length > 600)
      trainingError(401, 'PHOTO_EXPIRED', 'Обновите фото.');
    const [payload, mac, ...extra] = token.split('.');
    if (!payload || !mac || extra.length) trainingError(401, 'PHOTO_EXPIRED', 'Обновите фото.');
    const expected = createHmac('sha256', this.media.secret)
        .update('training-photo:' + payload)
        .digest(),
      actual = Buffer.from(mac, 'base64url');
    if (actual.length !== expected.length || !timingSafeEqual(actual, expected))
      trainingError(401, 'PHOTO_EXPIRED', 'Обновите фото.');
    let value: { user: string; id: string; expires: number };
    try {
      value = JSON.parse(Buffer.from(payload, 'base64url').toString()) as typeof value;
    } catch {
      trainingError(401, 'PHOTO_EXPIRED', 'Обновите фото.');
    }
    if (
      value.id !== id ||
      typeof value.user !== 'string' ||
      !Number.isFinite(value.expires) ||
      value.expires <= Date.now() / 1000 ||
      value.expires > Date.now() / 1000 + 300
    )
      trainingError(401, 'PHOTO_EXPIRED', 'Обновите фото.');
    const row = await this.permitted(trainingId(value.user), id);
    if (!row.photo_id) trainingError(404, 'PHOTO_UNAVAILABLE', 'Фото удалено.');
    const bytes = await readFile(this.path(row.photo_id)).catch(() => null);
    if (!bytes) trainingError(404, 'PHOTO_UNAVAILABLE', 'Фото недоступно.');
    res.set({ 'Content-Type': 'image/jpeg', 'Cache-Control': 'private, no-store' }).send(bytes);
  }
  public async remove(user: string, id: string) {
    return this.media.service.transaction(async (db) => {
      const r = await db.query(
        'DELETE FROM training_measurements WHERE id=$1 AND client_id=$2 RETURNING photo_id',
        [trainingId(id), user],
      );
      if (!r.rows[0]) trainingError(404, 'MEASUREMENT_UNAVAILABLE', 'Запись недоступна.');
      if (r.rows[0].photo_id) await rm(this.path(r.rows[0].photo_id), { force: true });
      return { saved: true };
    });
  }
  public async share(user: string, id: string, body: unknown) {
    if (!body || typeof body !== 'object' || !('share' in body) || typeof body.share !== 'boolean')
      trainingError(400, 'INVALID_SHARING', 'Выберите доступ.');
    return this.media.service.transaction(async (db) => {
      const r = await db.query(
        'UPDATE training_measurements SET share_with_trainer=$3 WHERE id=$1 AND client_id=$2 RETURNING id',
        [trainingId(id), user, body.share],
      );
      if (r.rowCount !== 1) trainingError(404, 'MEASUREMENT_UNAVAILABLE', 'Запись недоступна.');
      return { saved: true };
    });
  }
}
