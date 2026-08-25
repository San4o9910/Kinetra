import type {
  ProgramDirection,
  TrainerVideoProgramResponse,
  TrainerVideoSlotDto,
  TrainerVideoUploadDto,
  TrainerVideoUploadStatus,
} from '@kinetra/shared';

export const LIVE_UPLOAD_STATUSES: readonly TrainerVideoUploadStatus[] = [
  'creating',
  'uploading',
  'completing',
  'verification_pending',
  'verifying',
];

export interface VideoTrainerAuthority {
  readonly userId: string;
  readonly displayName: string;
}

export interface VideoSlotSnapshot {
  readonly videoId: string;
  readonly weekNumber: number;
  readonly dayOfWeek: number;
  readonly dayLabel: string;
  readonly direction: ProgramDirection;
  readonly title: string;
  readonly durationMinutes: number;
  readonly storageKey: string;
  readonly mediaAvailable: boolean;
  readonly mediaRevision: number;
  readonly durationSeconds: number;
  readonly uploadedAt: Date | null;
}

export interface VideoUploadSnapshot {
  readonly id: string;
  readonly targetVideoId: string;
  readonly uploaderUserId: string | null;
  readonly weekNumber: number;
  readonly dayOfWeek: number;
  readonly objectKey: string;
  readonly multipartUploadId: string | null;
  readonly idempotencyKey: string;
  readonly requestFingerprint: string;
  readonly status: TrainerVideoUploadStatus;
  readonly expectedSizeBytes: number;
  readonly partSizeBytes: number;
  readonly expectedPartCount: number;
  readonly targetMediaRevision: number;
  readonly actualSizeBytes: number | null;
  readonly sha256: string | null;
  readonly s3Etag: string | null;
  readonly s3VersionId: string | null;
  readonly durationSeconds: number | null;
  readonly width: number | null;
  readonly height: number | null;
  readonly videoCodec: string | null;
  readonly audioCodec: string | null;
  readonly lastErrorCode: string | null;
  readonly expiresAt: Date;
  readonly completedAt: Date | null;
  readonly verifiedAt: Date | null;
  readonly publishedAt: Date | null;
  readonly verificationAttemptCount: number;
}

export interface VideoPartManifest {
  readonly partNumber: number;
  readonly expectedSizeBytes: number;
  readonly checksumSha256Base64: string;
}

export interface ClaimedVideoUpload extends VideoUploadSnapshot {
  readonly leaseToken: string;
}

export type CompletionClaimResult =
  | { readonly kind: 'claimed'; readonly upload: ClaimedVideoUpload }
  | { readonly kind: 'in_progress'; readonly upload: VideoUploadSnapshot }
  | { readonly kind: 'state_conflict' };

export interface VideoPreviewObject {
  readonly objectKey: string;
  readonly versionId: string | null;
  readonly etag: string | null;
}

export interface VideoDeletionJob {
  readonly id: string;
  readonly objectKey: string;
  readonly versionId: string | null;
  readonly multipartUploadId: string | null;
  readonly attemptCount: number;
}

export interface VerifiedVideoMetadata {
  readonly actualSizeBytes: number;
  readonly sha256: string;
  readonly durationSeconds: number;
  readonly width: number;
  readonly height: number;
  readonly videoCodec: 'h264';
  readonly audioCodec: 'aac' | null;
}

export type ReserveUploadResult =
  | { readonly kind: 'created'; readonly upload: VideoUploadSnapshot }
  | { readonly kind: 'replayed'; readonly upload: VideoUploadSnapshot }
  | { readonly kind: 'conflict' }
  | { readonly kind: 'slot_busy' }
  | { readonly kind: 'limit' }
  | { readonly kind: 'rate_limited' }
  | { readonly kind: 'slot_not_found' };

export interface VideoAdminRepository {
  getAuthority(userId: string): Promise<VideoTrainerAuthority | null>;
  workersAreFresh(now: Date, maxStaleSeconds: number): Promise<boolean>;
  listProgram(): Promise<TrainerVideoProgramResponse>;
  reserveUpload(input: {
    readonly uploadId: string;
    readonly authority: VideoTrainerAuthority;
    readonly weekNumber: number;
    readonly dayOfWeek: number;
    readonly idempotencyKey: string;
    readonly requestFingerprint: string;
    readonly objectKey: string;
    readonly sizeBytes: number;
    readonly partSizeBytes: number;
    readonly partCount: number;
    readonly expiresAt: Date;
    readonly maxActivePerTrainer: number;
    readonly now: Date;
  }): Promise<ReserveUploadResult>;
  attachMultipart(uploadId: string, multipartUploadId: string): Promise<VideoUploadSnapshot | null>;
  failCreating(
    uploadId: string,
    errorCode: string,
    now: Date,
    multipartUploadId: string | null,
  ): Promise<void>;
  getUploadForTrainer(uploadId: string, trainerUserId: string): Promise<VideoUploadSnapshot | null>;
  claimPartSignBatch(
    uploadId: string,
    trainerUserId: string,
    now: Date,
  ): Promise<'allowed' | 'forbidden' | 'state_conflict' | 'rate_limited'>;
  savePartManifest(input: {
    readonly uploadId: string;
    readonly partNumber: number;
    readonly expectedSizeBytes: number;
    readonly checksumSha256Base64: string;
    readonly expiresAt: Date;
  }): Promise<'created' | 'replayed' | 'conflict'>;
  listPartManifests(uploadId: string): Promise<readonly VideoPartManifest[]>;
  beginCompletion(
    uploadId: string,
    trainerUserId: string,
    now: Date,
    leaseSeconds: number,
  ): Promise<CompletionClaimResult>;
  renewCompletionLease(
    uploadId: string,
    leaseToken: string,
    now: Date,
    leaseSeconds: number,
  ): Promise<boolean>;
  markVerificationPending(input: {
    readonly uploadId: string;
    readonly leaseToken: string;
    readonly sizeBytes: number;
    readonly etag: string | null;
    readonly versionId: string | null;
    readonly now: Date;
  }): Promise<VideoUploadSnapshot | null>;
  releaseCompletion(
    uploadId: string,
    leaseToken: string,
    now: Date,
  ): Promise<VideoUploadSnapshot | null>;
  cancelUpload(
    uploadId: string,
    trainerUserId: string,
    notBefore: Date,
    now: Date,
  ): Promise<VideoUploadSnapshot | null>;
  unpublish(
    weekNumber: number,
    dayOfWeek: number,
    trainerUserId: string,
    now: Date,
  ): Promise<TrainerVideoSlotDto>;
  getPreviewObject(videoId: string, trainerUserId: string): Promise<VideoPreviewObject | null>;
  claimVerification(now: Date, leaseSeconds: number): Promise<ClaimedVideoUpload | null>;
  renewVerificationLease(
    uploadId: string,
    leaseToken: string,
    now: Date,
    leaseSeconds: number,
  ): Promise<boolean>;
  publishVerified(input: {
    readonly uploadId: string;
    readonly leaseToken: string;
    readonly metadata: VerifiedVideoMetadata;
    readonly graceSeconds: number;
    readonly now: Date;
  }): Promise<'published' | 'cancelled' | 'superseded'>;
  failVerification(
    uploadId: string,
    leaseToken: string,
    errorCode: string,
    now: Date,
  ): Promise<void>;
  retryVerification(
    uploadId: string,
    leaseToken: string,
    errorCode: string,
    nextAttemptAt: Date,
    now: Date,
  ): Promise<boolean>;
  quarantineVerification(
    uploadId: string,
    leaseToken: string,
    errorCode: string,
    now: Date,
  ): Promise<boolean>;
  requeueQuarantinedVerification(
    uploadId: string,
    now: Date,
  ): Promise<'requeued' | 'slot_busy' | 'not_found'>;
  finalizeVerificationRun(now: Date, encounteredFailure: boolean): Promise<boolean>;
  expireUploads(now: Date, completionAmbiguityGraceSeconds: number): Promise<number>;
  claimDeletionJobs(now: Date, limit: number): Promise<readonly VideoDeletionJob[]>;
  isObjectReferenced(objectKey: string): Promise<boolean>;
  completeDeletion(jobId: string, now: Date): Promise<void>;
  retryDeletion(jobId: string, errorCode: string, nextAttemptAt: Date): Promise<void>;
  finalizeCleanupRun(now: Date, encounteredFailure: boolean): Promise<boolean>;
  updateHeartbeat(
    worker: 'upload_verifier' | 'media_cleanup',
    result: 'started' | 'succeeded' | 'failed',
    now: Date,
    errorCode?: string,
  ): Promise<void>;
}

export const toUploadDto = (
  upload: VideoUploadSnapshot,
  uploadedBytes = 0,
): TrainerVideoUploadDto => ({
  id: upload.id,
  video_id: upload.targetVideoId,
  week_number: upload.weekNumber,
  day_of_week: upload.dayOfWeek,
  status: upload.status,
  expected_size_bytes: upload.expectedSizeBytes,
  uploaded_bytes: uploadedBytes,
  part_size_bytes: upload.partSizeBytes,
  part_count: upload.expectedPartCount,
  expires_at: upload.expiresAt.toISOString(),
  failure_code: upload.lastErrorCode,
  verified_media:
    upload.sha256 === null ||
    upload.durationSeconds === null ||
    upload.width === null ||
    upload.height === null ||
    upload.videoCodec === null
      ? null
      : {
          duration_seconds: upload.durationSeconds,
          width: upload.width,
          height: upload.height,
          video_codec: upload.videoCodec,
          audio_codec: upload.audioCodec,
          sha256: upload.sha256,
        },
});
