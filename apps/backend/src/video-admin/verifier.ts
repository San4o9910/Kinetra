import { createHash, randomUUID } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile, spawnSync } from 'node:child_process';
import { Readable, Transform, type Writable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

import type { VerifiedVideoMetadata, VideoUploadSnapshot } from './repository.js';
import {
  hasExpectedVideoEncryption,
  type VideoEncryptionExpectation,
  type VideoStorage,
} from './storage.js';

const executeFfprobe = (
  ffprobePath: string,
  arguments_: readonly string[],
  signal?: AbortSignal,
): Promise<string> =>
  new Promise((resolve, reject) => {
    let settled = false;
    let abort: (() => void) | null = null;
    const child = execFile(
      ffprobePath,
      [...arguments_],
      {
        timeout: 30_000,
        maxBuffer: 256 * 1024,
        killSignal: 'SIGKILL',
        windowsHide: true,
        shell: false,
      },
      (caught, stdout) => {
        if (abort !== null) signal?.removeEventListener('abort', abort);
        if (settled) return;
        settled = true;
        if (caught !== null) reject(caught);
        else resolve(stdout);
      },
    );
    abort = () => {
      if (settled) return;
      settled = true;
      signal?.removeEventListener('abort', abort!);
      child.kill('SIGKILL');
      reject(
        signal?.reason instanceof Error
          ? signal.reason
          : new Error('Video verification was aborted.'),
      );
    };
    if (signal?.aborted) abort();
    else signal?.addEventListener('abort', abort, { once: true });
  });

export const assertVideoVerifierAvailable = (ffprobePath: string): void => {
  const result = spawnSync(ffprobePath, ['-version'], {
    encoding: 'utf8',
    maxBuffer: 64 * 1024,
    shell: false,
    timeout: 5_000,
    killSignal: 'SIGKILL',
    windowsHide: true,
  });
  if (result.error !== undefined || result.status !== 0) {
    throw new Error('TRAINER_VIDEO_UPLOADS_ENABLED=true requires an available ffprobe executable.');
  }
};

export const assertVideoVerifierRuntimeAvailable = async (signal?: AbortSignal): Promise<void> => {
  const directory = await mkdtemp(join(tmpdir(), 'kinetra-video-probe-'));
  const path = join(directory, `${randomUUID()}.tmp`);
  try {
    await pipeline(
      Readable.from([Buffer.from('kinetra', 'utf8')]),
      createWriteStream(path, {
        flags: 'wx',
        mode: 0o600,
      }),
      { signal },
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
};

export class VideoVerificationError extends Error {
  public constructor(public readonly code: string) {
    super(code);
  }
}

export class VideoVerificationRuntimeError extends Error {
  public constructor(
    public readonly code: string,
    options: ErrorOptions = {},
  ) {
    super(code, options);
  }
}

export class VideoVerificationInfrastructureError extends Error {
  public constructor(
    public readonly code: string,
    options: ErrorOptions = {},
  ) {
    super(code, options);
  }
}

interface ProbeStream {
  readonly codec_type?: unknown;
  readonly codec_name?: unknown;
  readonly width?: unknown;
  readonly height?: unknown;
  readonly avg_frame_rate?: unknown;
}

const finiteNumber = (value: unknown): number => {
  const number = Number(value);
  if (!Number.isFinite(number)) throw new VideoVerificationError('invalid_video_metadata');
  return number;
};

const frameRate = (value: unknown): number => {
  if (typeof value !== 'string') throw new VideoVerificationError('invalid_frame_rate');
  const [numerator, denominator] = value.split('/').map(Number);
  if (!Number.isFinite(numerator) || !Number.isFinite(denominator) || denominator === 0)
    throw new VideoVerificationError('invalid_frame_rate');
  return numerator! / denominator!;
};

const MP4_MAJOR_BRANDS = new Set([
  'M4V ',
  'avc1',
  'dash',
  'iso2',
  'iso3',
  'iso4',
  'iso5',
  'iso6',
  'isom',
  'mp41',
  'mp42',
]);

export class Mp4VideoVerifier {
  public constructor(
    private readonly storage: VideoStorage,
    private readonly ffprobePath: string,
    private readonly outputFactory: (path: string) => Writable = (path) =>
      createWriteStream(path, { flags: 'wx', mode: 0o600 }),
    private readonly expectedEncryption: Readonly<VideoEncryptionExpectation> = {
      serverSideEncryption: 'AES256',
      kmsKeyId: null,
    },
  ) {}

  public async verify(
    upload: VideoUploadSnapshot,
    options: { readonly signal?: AbortSignal } = {},
  ): Promise<VerifiedVideoMetadata> {
    const directory = await mkdtemp(join(tmpdir(), 'kinetra-video-'));
    const path = join(directory, `${randomUUID()}.mp4`);
    try {
      let head: Awaited<ReturnType<VideoStorage['headObject']>>;
      try {
        head = await this.storage.headObject(upload.objectKey, upload.s3VersionId, options.signal);
      } catch (caught) {
        throw new VideoVerificationInfrastructureError('verification_storage_failed', {
          cause: caught,
        });
      }
      if (head === null) throw new VideoVerificationRuntimeError('verification_object_unavailable');
      if (head.size !== upload.expectedSizeBytes)
        throw new VideoVerificationRuntimeError('verification_object_size_unconfirmed');
      if (
        head.uploadId !== upload.id ||
        !hasExpectedVideoEncryption(head, this.expectedEncryption) ||
        (upload.s3VersionId !== null && head.versionId !== upload.s3VersionId) ||
        (upload.s3VersionId === null &&
          (upload.s3Etag === null || head.etag === null || head.etag !== upload.s3Etag))
      ) {
        throw new VideoVerificationRuntimeError('verification_object_metadata_unconfirmed');
      }
      let object: Awaited<ReturnType<VideoStorage['getObject']>>;
      try {
        object = await this.storage.getObject(upload.objectKey, upload.s3VersionId, options.signal);
      } catch (caught) {
        throw new VideoVerificationInfrastructureError('verification_storage_failed', {
          cause: caught,
        });
      }
      if (object.contentLength !== upload.expectedSizeBytes)
        throw new VideoVerificationRuntimeError('verification_download_size_unconfirmed');
      const hash = createHash('sha256');
      let written = 0;
      let prefix = Buffer.alloc(0);
      const inspect = new Transform({
        transform(rawChunk: Buffer, _encoding, callback) {
          const chunk = Buffer.from(rawChunk);
          written += chunk.length;
          if (written > upload.expectedSizeBytes) {
            callback(new VideoVerificationRuntimeError('verification_download_size_unconfirmed'));
            return;
          }
          hash.update(chunk);
          if (prefix.length < 16)
            prefix = Buffer.concat([prefix, chunk.subarray(0, 16 - prefix.length)]);
          callback(null, chunk);
        },
      });
      try {
        await pipeline(Readable.from(object.body), inspect, this.outputFactory(path), {
          signal: options.signal,
        });
      } catch (caught) {
        if (
          caught instanceof VideoVerificationError ||
          caught instanceof VideoVerificationRuntimeError
        )
          throw caught;
        throw new VideoVerificationInfrastructureError('verification_stream_failed', {
          cause: caught,
        });
      }
      if (written !== upload.expectedSizeBytes)
        throw new VideoVerificationRuntimeError('verification_download_incomplete');
      if (prefix.length < 12 || prefix.subarray(4, 8).toString('ascii') !== 'ftyp')
        throw new VideoVerificationError('invalid_mp4_container');
      const majorBrand = prefix.subarray(8, 12).toString('ascii');
      if (!MP4_MAJOR_BRANDS.has(majorBrand))
        throw new VideoVerificationError('invalid_mp4_container');

      if (upload.s3VersionId === null) {
        let after: Awaited<ReturnType<VideoStorage['headObject']>>;
        try {
          after = await this.storage.headObject(upload.objectKey, null, options.signal);
        } catch (caught) {
          throw new VideoVerificationInfrastructureError('verification_storage_failed', {
            cause: caught,
          });
        }
        if (
          after === null ||
          after.size !== head.size ||
          after.etag !== head.etag ||
          after.uploadId !== head.uploadId ||
          !hasExpectedVideoEncryption(after, this.expectedEncryption)
        )
          throw new VideoVerificationRuntimeError('object_changed_during_verification');
      }

      let stdout: string;
      try {
        stdout = await executeFfprobe(
          this.ffprobePath,
          [
            '-v',
            'error',
            '-show_entries',
            'format=format_name,duration:stream=codec_type,codec_name,width,height,avg_frame_rate',
            '-of',
            'json',
            path,
          ],
          options.signal,
        );
      } catch (caught) {
        throw new VideoVerificationRuntimeError('ffprobe_process_failed', { cause: caught });
      }
      let rawProbe: unknown;
      try {
        rawProbe = JSON.parse(stdout) as unknown;
      } catch {
        throw new VideoVerificationRuntimeError('ffprobe_invalid_output');
      }
      const isRecord = (value: unknown): value is Record<string, unknown> =>
        typeof value === 'object' && value !== null && !Array.isArray(value);
      if (
        !isRecord(rawProbe) ||
        !isRecord(rawProbe.format) ||
        typeof rawProbe.format.format_name !== 'string' ||
        rawProbe.format.format_name.length === 0 ||
        !['string', 'number'].includes(typeof rawProbe.format.duration) ||
        !Array.isArray(rawProbe.streams) ||
        rawProbe.streams.some(
          (stream) => !isRecord(stream) || typeof stream.codec_type !== 'string',
        )
      )
        throw new VideoVerificationRuntimeError('ffprobe_invalid_output');
      const probe = {
        format: rawProbe.format,
        streams: rawProbe.streams as ProbeStream[],
      };
      if (
        typeof probe.format?.format_name !== 'string' ||
        !probe.format.format_name
          .split(',')
          .some((name) => ['mov', 'mp4', 'm4a', '3gp', '3g2', 'mj2'].includes(name))
      )
        throw new VideoVerificationError('invalid_mp4_container');
      const streams = probe.streams ?? [];
      const videos = streams.filter((stream) => stream.codec_type === 'video');
      const audios = streams.filter((stream) => stream.codec_type === 'audio');
      if (
        videos.length !== 1 ||
        audios.length > 1 ||
        streams.length !== videos.length + audios.length
      )
        throw new VideoVerificationError('invalid_stream_count');
      const video = videos[0]!;
      if (
        typeof video.codec_name !== 'string' ||
        !['string', 'number'].includes(typeof video.width) ||
        !['string', 'number'].includes(typeof video.height) ||
        typeof video.avg_frame_rate !== 'string' ||
        audios.some((audio) => typeof audio.codec_name !== 'string')
      )
        throw new VideoVerificationRuntimeError('ffprobe_invalid_output');
      if (video.codec_name !== 'h264') throw new VideoVerificationError('unsupported_video_codec');
      if (audios.some((audio) => audio.codec_name !== 'aac'))
        throw new VideoVerificationError('unsupported_audio_codec');
      const rawDuration = finiteNumber(probe.format?.duration);
      const width = finiteNumber(video.width);
      const height = finiteNumber(video.height);
      const fps = frameRate(video.avg_frame_rate);
      if (rawDuration < 10 || rawDuration > 10_800)
        throw new VideoVerificationError('invalid_duration');
      const duration = Math.round(rawDuration);
      if (
        !Number.isInteger(width) ||
        !Number.isInteger(height) ||
        width < 1 ||
        height < 1 ||
        width > 3840 ||
        height > 2160
      )
        throw new VideoVerificationError('invalid_resolution');
      if (fps <= 0 || fps > 60) throw new VideoVerificationError('invalid_frame_rate');
      return {
        actualSizeBytes: written,
        sha256: hash.digest('hex'),
        durationSeconds: duration,
        width,
        height,
        videoCodec: 'h264',
        audioCodec: audios.length === 0 ? null : 'aac',
      };
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }
}
