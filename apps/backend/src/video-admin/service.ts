import type {
  TrainerVideoPartRequest,
  TrainerVideoPartUrlDto,
  TrainerVideoProgramResponse,
  TrainerVideoSlotDto,
  TrainerVideoUploadDto,
} from '@kinetra/shared';
import { createHash, randomUUID } from 'node:crypto';

import { HttpError } from '../auth/errors.js';
import type { Clock } from '../auth/service.js';
import type { VideoUploadsEnvironment } from '../config/env.js';
import type {
  VideoAdminRepository,
  VideoTrainerAuthority,
  VideoUploadSnapshot,
} from './repository.js';
import { toUploadDto } from './repository.js';
import { hasExpectedVideoEncryption, type StoredVideoPart, type VideoStorage } from './storage.js';

export interface CreateVideoUploadInput {
  readonly week_number: number;
  readonly day_of_week: number;
  readonly mime_type: 'video/mp4';
  readonly size_bytes: number;
}

const error = (status: number, code: string, message: string): HttpError =>
  new HttpError(status, code, message);

const fingerprint = (input: CreateVideoUploadInput): string =>
  createHash('sha256')
    .update(
      `${input.week_number}\n${input.day_of_week}\n${input.mime_type}\n${input.size_bytes}`,
      'utf8',
    )
    .digest('hex');

const expectedPartSize = (upload: VideoUploadSnapshot, partNumber: number): number => {
  if (partNumber < 1 || partNumber > upload.expectedPartCount) {
    throw error(400, 'VIDEO_UPLOAD_INVALID_REQUEST', 'Part number is outside this upload.');
  }
  const offset = (partNumber - 1) * upload.partSizeBytes;
  return Math.min(upload.partSizeBytes, upload.expectedSizeBytes - offset);
};

const completionAccepted = (status: VideoUploadSnapshot['status']): boolean =>
  ['completing', 'verification_pending', 'verifying', 'published'].includes(status);

interface CompletionLeaseGuard {
  readonly signal: AbortSignal;
  fence(): Promise<boolean>;
  stop(): Promise<void>;
}

const completionLeaseGuard = (
  repository: VideoAdminRepository,
  upload: { readonly id: string; readonly leaseToken: string },
  clock: Clock,
  leaseSeconds: number,
  deadlineSeconds: number,
): CompletionLeaseGuard => {
  const controller = new AbortController();
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let inFlight: Promise<boolean> | null = null;
  const deadline = setTimeout(
    () => controller.abort(new Error('Video completion deadline exceeded.')),
    deadlineSeconds * 1000,
  );
  const intervalMs = Math.max(10, Math.floor((leaseSeconds * 1000) / 3));
  const renew = async (): Promise<boolean> => {
    try {
      const renewed = await repository.renewCompletionLease(
        upload.id,
        upload.leaseToken,
        clock.now(),
        leaseSeconds,
      );
      if (!renewed) controller.abort(new Error('Video completion lease was lost.'));
      return renewed;
    } catch (caught) {
      controller.abort(new Error('Video completion lease renewal failed.', { cause: caught }));
      return false;
    }
  };
  const renewSerialized = (): Promise<boolean> => {
    if (inFlight !== null) return inFlight;
    const current = renew();
    inFlight = current;
    void current.finally(() => {
      if (inFlight === current) inFlight = null;
    });
    return current;
  };
  const schedule = (): void => {
    if (stopped || controller.signal.aborted) return;
    timer = setTimeout(() => {
      timer = null;
      if (stopped || controller.signal.aborted) return;
      void renewSerialized().finally(schedule);
    }, intervalMs);
  };
  controller.signal.addEventListener(
    'abort',
    () => {
      if (timer !== null) clearTimeout(timer);
      timer = null;
    },
    { once: true },
  );
  schedule();
  return {
    signal: controller.signal,
    fence: async () => {
      if (controller.signal.aborted || stopped) return false;
      const renewed = await renewSerialized();
      return renewed && !controller.signal.aborted && !stopped;
    },
    stop: async () => {
      stopped = true;
      clearTimeout(deadline);
      if (timer !== null) clearTimeout(timer);
      timer = null;
      if (inFlight !== null) await inFlight;
    },
  };
};

export class VideoAdminService {
  public constructor(
    private readonly repository: VideoAdminRepository,
    private readonly storage: VideoStorage,
    private readonly configuration: Readonly<VideoUploadsEnvironment>,
    private readonly clock: Clock,
  ) {}

  private async authority(userId: string): Promise<VideoTrainerAuthority> {
    if (!this.configuration.enabled) {
      throw error(503, 'VIDEO_UPLOADS_DISABLED', 'Video management is not enabled.');
    }
    const authority = await this.repository.getAuthority(userId);
    if (authority === null) {
      throw error(
        403,
        'VIDEO_ADMIN_FORBIDDEN',
        'Video management is not available for this account.',
      );
    }
    return authority;
  }

  public async getProgram(userId: string): Promise<TrainerVideoProgramResponse> {
    await this.authority(userId);
    return this.repository.listProgram();
  }

  public async createUpload(
    userId: string,
    idempotencyKey: string,
    input: CreateVideoUploadInput,
  ): Promise<{ created: boolean; upload: TrainerVideoUploadDto }> {
    const authority = await this.authority(userId);
    if (
      !this.storage.available ||
      !(await this.repository.workersAreFresh(
        this.clock.now(),
        this.configuration.workerMaxStaleSeconds,
      ))
    ) {
      throw error(503, 'VIDEO_STORAGE_UNAVAILABLE', 'Video storage is temporarily unavailable.');
    }
    if (input.mime_type !== 'video/mp4')
      throw error(415, 'VIDEO_UPLOAD_INVALID_TYPE', 'Only MP4 video is supported.');
    if (input.size_bytes > this.configuration.maxBytes)
      throw error(413, 'VIDEO_UPLOAD_TOO_LARGE', 'The selected video is too large.');

    const now = this.clock.now();
    const uploadId = randomUUID();
    const paddedWeek = String(input.week_number).padStart(2, '0');
    const objectKey = `videos/workouts/week-${paddedWeek}/day-${input.day_of_week}/${uploadId}.mp4`;
    const reserved = await this.repository.reserveUpload({
      uploadId,
      authority,
      weekNumber: input.week_number,
      dayOfWeek: input.day_of_week,
      idempotencyKey,
      requestFingerprint: fingerprint(input),
      objectKey,
      sizeBytes: input.size_bytes,
      partSizeBytes: this.configuration.partSizeBytes,
      partCount: Math.ceil(input.size_bytes / this.configuration.partSizeBytes),
      expiresAt: new Date(now.getTime() + this.configuration.sessionTtlSeconds * 1000),
      maxActivePerTrainer: this.configuration.maxActivePerTrainer,
      now,
    });
    if (reserved.kind === 'replayed')
      return { created: false, upload: toUploadDto(reserved.upload) };
    if (reserved.kind === 'conflict')
      throw error(
        409,
        'VIDEO_UPLOAD_IDEMPOTENCY_CONFLICT',
        'Idempotency key was already used for a different request.',
      );
    if (reserved.kind === 'slot_busy')
      throw error(
        409,
        'VIDEO_UPLOAD_IN_PROGRESS',
        'This workout already has an upload in progress.',
      );
    if (reserved.kind === 'limit' || reserved.kind === 'rate_limited')
      throw error(429, 'VIDEO_UPLOAD_LIMIT_REACHED', 'Video upload limit has been reached.');
    if (reserved.kind === 'slot_not_found')
      throw error(404, 'WORKOUT_SLOT_NOT_FOUND', 'Workout slot was not found.');

    let multipartId: string | null = null;
    try {
      multipartId = await this.storage.createMultipart({
        uploadId: reserved.upload.id,
        videoId: reserved.upload.targetVideoId,
        objectKey: reserved.upload.objectKey,
      });
      const upload = await this.repository.attachMultipart(reserved.upload.id, multipartId);
      if (upload === null) {
        await this.storage.abortMultipart(reserved.upload.objectKey, multipartId);
        throw new Error('Upload reservation changed before S3 creation completed.');
      }
      return { created: true, upload: toUploadDto(upload) };
    } catch {
      await this.repository.failCreating(
        reserved.upload.id,
        'storage_create_failed',
        this.clock.now(),
        multipartId,
      );
      throw error(503, 'VIDEO_STORAGE_UNAVAILABLE', 'Video storage is temporarily unavailable.');
    }
  }

  public async signParts(
    userId: string,
    uploadId: string,
    parts: readonly TrainerVideoPartRequest[],
  ): Promise<readonly TrainerVideoPartUrlDto[]> {
    await this.authority(userId);
    const upload = await this.requireUpload(uploadId, userId);
    if (
      upload.status !== 'uploading' ||
      upload.multipartUploadId === null ||
      upload.expiresAt <= this.clock.now()
    ) {
      throw error(
        409,
        upload.expiresAt <= this.clock.now()
          ? 'VIDEO_UPLOAD_EXPIRED'
          : 'VIDEO_UPLOAD_STATE_CONFLICT',
        'Upload cannot accept parts in its current state.',
      );
    }
    const signClaim = await this.repository.claimPartSignBatch(uploadId, userId, this.clock.now());
    if (signClaim === 'forbidden')
      throw error(
        403,
        'VIDEO_ADMIN_FORBIDDEN',
        'Video management is not available for this account.',
      );
    if (signClaim === 'rate_limited')
      throw error(429, 'VIDEO_UPLOAD_LIMIT_REACHED', 'Video upload limit has been reached.');
    if (signClaim === 'state_conflict')
      throw error(
        409,
        'VIDEO_UPLOAD_STATE_CONFLICT',
        'Upload cannot accept parts in its current state.',
      );
    const expiresAt = new Date(
      this.clock.now().getTime() + this.configuration.partUrlTtlSeconds * 1000,
    );
    const output: TrainerVideoPartUrlDto[] = [];
    for (const part of parts) {
      const size = expectedPartSize(upload, part.part_number);
      const saved = await this.repository.savePartManifest({
        uploadId,
        partNumber: part.part_number,
        expectedSizeBytes: size,
        checksumSha256Base64: part.checksum_sha256,
        expiresAt,
      });
      if (saved === 'conflict')
        throw error(
          409,
          'VIDEO_UPLOAD_STATE_CONFLICT',
          'This part was already signed with different content.',
        );
      const uploadUrl = await this.storage.signPart({
        objectKey: upload.objectKey,
        multipartUploadId: upload.multipartUploadId,
        partNumber: part.part_number,
        size,
        checksumSha256: part.checksum_sha256,
        expiresInSeconds: this.configuration.partUrlTtlSeconds,
      });
      output.push({
        part_number: part.part_number,
        upload_url: uploadUrl,
        expires_at: expiresAt.toISOString(),
        required_headers: { 'x-amz-checksum-sha256': part.checksum_sha256 },
      });
    }
    await this.authority(userId);
    return output;
  }

  public async listParts(
    userId: string,
    uploadId: string,
  ): Promise<{
    parts: readonly { part_number: number; size_bytes: number; checksum_sha256: string }[];
  }> {
    await this.authority(userId);
    const upload = await this.requireUpload(uploadId, userId);
    if (upload.multipartUploadId === null || !['uploading', 'completing'].includes(upload.status))
      return { parts: [] };
    const parts = await this.storage.listParts(upload.objectKey, upload.multipartUploadId);
    const manifests = await this.repository.listPartManifests(upload.id);
    const manifestByPart = new Map(manifests.map((part) => [part.partNumber, part]));
    return {
      parts: parts.flatMap((part) => {
        const manifest = manifestByPart.get(part.partNumber);
        return manifest !== undefined &&
          manifest.expectedSizeBytes === part.size &&
          manifest.checksumSha256Base64 === part.checksumSha256
          ? [
              {
                part_number: part.partNumber,
                size_bytes: part.size,
                checksum_sha256: manifest.checksumSha256Base64,
              },
            ]
          : [];
      }),
    };
  }

  public async getUpload(userId: string, uploadId: string): Promise<TrainerVideoUploadDto> {
    await this.authority(userId);
    const upload = await this.requireUpload(uploadId, userId);
    let uploadedBytes = upload.actualSizeBytes ?? 0;
    if (upload.status === 'uploading' && upload.multipartUploadId !== null) {
      try {
        uploadedBytes = (
          await this.storage.listParts(upload.objectKey, upload.multipartUploadId)
        ).reduce((total, part) => total + part.size, 0);
      } catch {
        // Poll remains safe when the storage list is transiently unavailable.
      }
    }
    return toUploadDto(upload, uploadedBytes);
  }

  public async complete(userId: string, uploadId: string): Promise<TrainerVideoUploadDto> {
    await this.authority(userId);
    const existing = await this.requireUpload(uploadId, userId);
    if (completionAccepted(existing.status) && existing.status !== 'completing')
      return toUploadDto(existing, existing.expectedSizeBytes);
    const claim = await this.repository.beginCompletion(
      uploadId,
      userId,
      this.clock.now(),
      this.configuration.verifyLeaseSeconds,
    );
    if (claim.kind === 'in_progress')
      return toUploadDto(claim.upload, claim.upload.expectedSizeBytes);
    if (claim.kind === 'state_conflict' || claim.upload.multipartUploadId === null)
      throw error(
        409,
        'VIDEO_UPLOAD_STATE_CONFLICT',
        'Upload cannot be completed in its current state.',
      );
    const upload = claim.upload;
    const lease = completionLeaseGuard(
      this.repository,
      upload,
      this.clock,
      this.configuration.verifyLeaseSeconds,
      this.configuration.verifyDeadlineSeconds,
    );
    try {
      const multipartUploadId = upload.multipartUploadId;
      if (multipartUploadId === null)
        throw error(409, 'VIDEO_UPLOAD_STATE_CONFLICT', 'Upload has no multipart session.');
      let storedParts: readonly StoredVideoPart[];
      let manifests: Awaited<ReturnType<VideoAdminRepository['listPartManifests']>>;
      try {
        [storedParts, manifests] = await Promise.all([
          this.storage.listParts(upload.objectKey, multipartUploadId, lease.signal),
          this.repository.listPartManifests(upload.id),
        ]);
      } catch {
        const head = await this.storage
          .headObject(upload.objectKey, null, lease.signal)
          .catch(() => null);
        if (
          head !== null &&
          head.uploadId === upload.id &&
          head.size === upload.expectedSizeBytes &&
          (await lease.fence())
        )
          return this.acceptCompletedHeadWithReconciliation(
            userId,
            upload,
            upload.leaseToken,
            head,
            head.etag,
            head.versionId,
          );
        throw error(
          503,
          'VIDEO_STORAGE_UNAVAILABLE',
          'Video completion could not inspect uploaded parts. Retry safely.',
        );
      }
      if (lease.signal.aborted)
        throw error(
          503,
          'VIDEO_STORAGE_UNAVAILABLE',
          'Video completion lease was lost before multipart completion.',
        );
      try {
        this.assertComplete(upload, storedParts, manifests);
      } catch (caught) {
        if (!(caught instanceof HttpError)) throw caught;
        await lease.stop();
        let released: VideoUploadSnapshot | null;
        try {
          released = await this.repository.releaseCompletion(
            upload.id,
            upload.leaseToken,
            this.clock.now(),
          );
        } catch {
          throw error(
            503,
            'VIDEO_STORAGE_UNAVAILABLE',
            'Upload state could not be reopened safely. Retry completion.',
          );
        }
        if (released !== null) throw caught;
        const reconciled = await this.reconcileCompletion(userId, upload.id);
        if (reconciled !== null) return reconciled;
        throw caught;
      }
      let completedResult: {
        readonly etag: string | null;
        readonly versionId: string | null;
      } | null = null;
      try {
        if (!(await lease.fence()))
          throw error(
            503,
            'VIDEO_STORAGE_UNAVAILABLE',
            'Video completion lease was lost before multipart completion.',
          );
        completedResult = await this.storage.completeMultipart(
          upload.objectKey,
          multipartUploadId,
          storedParts,
          lease.signal,
        );
        if (!(await lease.fence()))
          throw error(
            503,
            'VIDEO_STORAGE_UNAVAILABLE',
            'Video completion lease was lost after multipart completion.',
          );
        const head = await this.storage.headObject(
          upload.objectKey,
          completedResult.versionId,
          lease.signal,
        );
        return this.acceptCompletedHeadWithReconciliation(
          userId,
          upload,
          upload.leaseToken,
          head,
          completedResult.etag,
          completedResult.versionId,
        );
      } catch (caught) {
        const head = await this.storage
          .headObject(upload.objectKey, completedResult?.versionId ?? null, lease.signal)
          .catch(() => null);
        if (
          head !== null &&
          head.uploadId === upload.id &&
          head.size === upload.expectedSizeBytes &&
          (await lease.fence())
        ) {
          return this.acceptCompletedHeadWithReconciliation(
            userId,
            upload,
            upload.leaseToken,
            head,
            completedResult?.etag ?? head.etag,
            completedResult?.versionId ?? head.versionId,
          );
        }
        if (caught instanceof HttpError) {
          const reconciled = await this.reconcileCompletion(userId, upload.id);
          if (reconciled !== null) return reconciled;
          throw caught;
        }
        throw error(
          503,
          'VIDEO_STORAGE_UNAVAILABLE',
          'Video completion could not be confirmed. Retry safely.',
        );
      }
    } finally {
      await lease.stop();
    }
  }

  public async cancel(userId: string, uploadId: string): Promise<TrainerVideoUploadDto> {
    await this.authority(userId);
    const existing = await this.requireUpload(uploadId, userId);
    if (existing.status === 'published')
      throw error(
        409,
        'VIDEO_UPLOAD_STATE_CONFLICT',
        'Published video must be hidden with the separate action.',
      );
    const now = this.clock.now();
    const notBefore = new Date(now.getTime() + (this.configuration.partUrlTtlSeconds + 60) * 1000);
    const cancelled = await this.repository.cancelUpload(uploadId, userId, notBefore, now);
    if (cancelled === null)
      throw error(404, 'VIDEO_UPLOAD_NOT_FOUND', 'Video upload was not found.');
    if (cancelled.status === 'published')
      throw error(
        409,
        'VIDEO_UPLOAD_STATE_CONFLICT',
        'Published video must be hidden with the separate action.',
      );
    if (
      existing.multipartUploadId !== null &&
      ['creating', 'uploading', 'completing'].includes(existing.status)
    ) {
      await this.storage
        .abortMultipart(existing.objectKey, existing.multipartUploadId)
        .catch(() => undefined);
    }
    return toUploadDto(cancelled);
  }

  public async preview(
    userId: string,
    videoId: string,
  ): Promise<{ url: string; expires_at: string }> {
    await this.authority(userId);
    const object = await this.repository.getPreviewObject(videoId, userId);
    if (object === null)
      throw error(404, 'WORKOUT_SLOT_NOT_FOUND', 'Published workout video was not found.');
    const ttl = Math.min(300, this.configuration.partUrlTtlSeconds);
    if (object.versionId === null) {
      let head: Awaited<ReturnType<VideoStorage['headObject']>>;
      try {
        head = await this.storage.headObject(object.objectKey);
      } catch {
        throw error(
          503,
          'VIDEO_STORAGE_UNAVAILABLE',
          'Published video identity could not be confirmed.',
        );
      }
      if (object.etag === null || head === null || head.etag !== object.etag) {
        throw error(
          409,
          'VIDEO_UPLOAD_VERIFICATION_FAILED',
          'Published video identity no longer matches the verified object.',
        );
      }
    }
    const url = await this.storage.signGet(object.objectKey, ttl, object.versionId);
    await this.authority(userId);
    return {
      url,
      expires_at: new Date(this.clock.now().getTime() + ttl * 1000).toISOString(),
    };
  }

  public async unpublish(
    userId: string,
    weekNumber: number,
    dayOfWeek: number,
  ): Promise<TrainerVideoSlotDto> {
    await this.authority(userId);
    try {
      return await this.repository.unpublish(weekNumber, dayOfWeek, userId, this.clock.now());
    } catch {
      throw error(404, 'WORKOUT_SLOT_NOT_FOUND', 'Workout slot was not found.');
    }
  }

  private async requireUpload(uploadId: string, userId: string): Promise<VideoUploadSnapshot> {
    const upload = await this.repository.getUploadForTrainer(uploadId, userId);
    if (upload === null) throw error(404, 'VIDEO_UPLOAD_NOT_FOUND', 'Video upload was not found.');
    return upload;
  }

  private assertComplete(
    upload: VideoUploadSnapshot,
    stored: readonly StoredVideoPart[],
    manifests: readonly {
      partNumber: number;
      expectedSizeBytes: number;
      checksumSha256Base64: string;
    }[],
  ): void {
    if (stored.length !== upload.expectedPartCount || manifests.length !== upload.expectedPartCount)
      throw error(409, 'VIDEO_UPLOAD_INCOMPLETE', 'Not all video parts were uploaded.');
    let total = 0;
    for (let index = 0; index < upload.expectedPartCount; index += 1) {
      const partNumber = index + 1;
      const actual = stored[index];
      const manifest = manifests[index];
      const expectedSize = expectedPartSize(upload, partNumber);
      if (
        actual?.partNumber !== partNumber ||
        manifest?.partNumber !== partNumber ||
        actual.size !== expectedSize ||
        manifest.expectedSizeBytes !== expectedSize ||
        actual.checksumSha256 !== manifest.checksumSha256Base64
      ) {
        throw error(
          409,
          'VIDEO_UPLOAD_INCOMPLETE',
          'Video parts do not match the signed manifest.',
        );
      }
      total += actual.size;
    }
    if (total !== upload.expectedSizeBytes)
      throw error(
        409,
        'VIDEO_UPLOAD_INCOMPLETE',
        'Video size does not match the upload reservation.',
      );
  }

  private async acceptCompletedHead(
    upload: VideoUploadSnapshot,
    leaseToken: string,
    head: Awaited<ReturnType<VideoStorage['headObject']>>,
    etag: string | null,
    versionId: string | null,
  ): Promise<TrainerVideoUploadDto> {
    if (
      head === null ||
      head.size !== upload.expectedSizeBytes ||
      head.uploadId !== upload.id ||
      !hasExpectedVideoEncryption(head, this.configuration) ||
      (versionId !== null && head.versionId !== versionId) ||
      (versionId === null && (etag === null || head.etag === null || head.etag !== etag))
    ) {
      throw error(
        409,
        'VIDEO_UPLOAD_VERIFICATION_FAILED',
        'Uploaded object metadata did not pass validation.',
      );
    }
    let pending: VideoUploadSnapshot | null;
    try {
      pending = await this.repository.markVerificationPending({
        uploadId: upload.id,
        leaseToken,
        sizeBytes: head.size,
        etag: versionId === null ? etag : head.etag,
        versionId: versionId ?? head.versionId,
        now: this.clock.now(),
      });
    } catch {
      throw error(
        503,
        'VIDEO_STORAGE_UNAVAILABLE',
        'Completed upload state could not be recorded. Retry safely.',
      );
    }
    if (pending === null) {
      const userId = upload.uploaderUserId;
      if (userId !== null) {
        const reconciled = await this.reconcileCompletion(userId, upload.id);
        if (reconciled !== null) return reconciled;
      }
      throw error(409, 'VIDEO_UPLOAD_STATE_CONFLICT', 'Upload state changed before verification.');
    }
    return toUploadDto(pending, pending.expectedSizeBytes);
  }

  private async acceptCompletedHeadWithReconciliation(
    userId: string,
    upload: VideoUploadSnapshot,
    leaseToken: string,
    head: Awaited<ReturnType<VideoStorage['headObject']>>,
    etag: string | null,
    versionId: string | null,
  ): Promise<TrainerVideoUploadDto> {
    try {
      return await this.acceptCompletedHead(upload, leaseToken, head, etag, versionId);
    } catch (caught) {
      if (caught instanceof HttpError && caught.code === 'VIDEO_STORAGE_UNAVAILABLE') {
        const reconciled = await this.reconcileCompletion(userId, upload.id);
        if (reconciled !== null) return reconciled;
      }
      throw caught;
    }
  }

  private async reconcileCompletion(
    userId: string,
    uploadId: string,
  ): Promise<TrainerVideoUploadDto | null> {
    let current: VideoUploadSnapshot | null;
    try {
      current = await this.repository.getUploadForTrainer(uploadId, userId);
    } catch {
      throw error(
        503,
        'VIDEO_STORAGE_UNAVAILABLE',
        'Upload reconciliation is temporarily unavailable. Retry safely.',
      );
    }
    return current !== null && completionAccepted(current.status)
      ? toUploadDto(current, current.expectedSizeBytes)
      : null;
  }
}
