import type { Clock } from '../auth/service.js';
import type { VideoVerificationEnvironment } from '../config/job-env.js';
import type { VideoAdminRepository } from './repository.js';
import type { VideoStorage } from './storage.js';
import {
  assertVideoVerifierAvailable,
  assertVideoVerifierRuntimeAvailable,
  Mp4VideoVerifier,
  VideoVerificationError,
  VideoVerificationRuntimeError,
} from './verifier.js';

const retryDelayMs = (attempt: number): number =>
  Math.min(6 * 60 * 60 * 1000, 30_000 * 2 ** Math.min(attempt - 1, 10));

const abortReason = (signal: AbortSignal): Error =>
  signal.reason instanceof Error ? signal.reason : new Error('Video cleanup deadline exceeded.');

const awaitWithSignal = async <T>(operation: () => Promise<T>, signal: AbortSignal): Promise<T> => {
  if (signal.aborted) throw abortReason(signal);
  return new Promise<T>((resolve, reject) => {
    const onAbort = (): void => reject(abortReason(signal));
    signal.addEventListener('abort', onAbort, { once: true });
    let pending: Promise<T>;
    try {
      pending = operation();
    } catch (caught) {
      signal.removeEventListener('abort', onAbort);
      reject(caught);
      return;
    }
    void pending.then(resolve, reject).finally(() => {
      signal.removeEventListener('abort', onAbort);
    });
  });
};

interface VerificationLeaseGuard {
  readonly signal: AbortSignal;
  fenceBeforePublish(): Promise<boolean>;
  stop(): Promise<void>;
}

const verificationLeaseGuard = (
  repository: VideoAdminRepository,
  upload: { readonly id: string; readonly leaseToken: string },
  clock: Clock,
  leaseSeconds: number,
  deadlineSeconds: number,
): VerificationLeaseGuard => {
  const controller = new AbortController();
  let stopped = false;
  let renewalTimer: ReturnType<typeof setTimeout> | null = null;
  let inFlight: Promise<boolean> | null = null;
  const deadline = setTimeout(
    () => controller.abort(new Error('Video verification deadline exceeded.')),
    deadlineSeconds * 1000,
  );
  const intervalMs = Math.max(10, Math.floor((leaseSeconds * 1000) / 3));
  const renew = async (): Promise<boolean> => {
    try {
      const renewed = await repository.renewVerificationLease(
        upload.id,
        upload.leaseToken,
        clock.now(),
        leaseSeconds,
      );
      if (!renewed) controller.abort(new Error('Video verification lease was lost.'));
      return renewed;
    } catch (caught) {
      controller.abort(new Error('Video verification lease renewal failed.', { cause: caught }));
      return false;
    }
  };
  const schedule = (): void => {
    if (stopped || controller.signal.aborted) return;
    renewalTimer = setTimeout(() => {
      renewalTimer = null;
      if (stopped || controller.signal.aborted) return;
      const current = renew();
      inFlight = current;
      void current.finally(() => {
        if (inFlight === current) inFlight = null;
        schedule();
      });
    }, intervalMs);
  };
  schedule();
  const stopPeriodic = async (): Promise<void> => {
    stopped = true;
    if (renewalTimer !== null) clearTimeout(renewalTimer);
    renewalTimer = null;
    if (inFlight !== null) await inFlight;
  };
  return {
    signal: controller.signal,
    fenceBeforePublish: async () => {
      await stopPeriodic();
      if (controller.signal.aborted) return false;
      const renewed = await renew();
      return renewed && !controller.signal.aborted;
    },
    stop: async () => {
      clearTimeout(deadline);
      await stopPeriodic();
    },
  };
};

export class VideoUploadWorkerService {
  private readonly verifier: Pick<Mp4VideoVerifier, 'verify'>;
  public constructor(
    private readonly repository: VideoAdminRepository,
    private readonly storage: VideoStorage,
    private readonly config: Readonly<VideoVerificationEnvironment>,
    private readonly clock: Clock,
    verifier?: Pick<Mp4VideoVerifier, 'verify'>,
  ) {
    this.verifier =
      verifier ?? new Mp4VideoVerifier(storage, config.ffprobePath, undefined, config);
  }
  public async runOnce(limit = 20): Promise<{ processed: number; expired: number }> {
    await this.repository.updateHeartbeat('upload_verifier', 'started', this.clock.now());
    let processed = 0;
    let degraded = false;
    let failedHeartbeatRecorded = false;
    try {
      assertVideoVerifierAvailable(this.config.ffprobePath);
      const probeController = new AbortController();
      const probeDeadline = setTimeout(
        () => probeController.abort(new Error('Video verifier recovery probe timed out.')),
        Math.min(30, this.config.verifyDeadlineSeconds) * 1000,
      );
      try {
        await assertVideoVerifierRuntimeAvailable(probeController.signal);
        await this.storage.probeAccess(probeController.signal);
      } finally {
        clearTimeout(probeDeadline);
      }
      const expired = await this.repository.expireUploads(
        this.clock.now(),
        this.config.verifyDeadlineSeconds + this.config.verifyLeaseSeconds + 60,
      );
      while (processed < limit) {
        const upload = await this.repository.claimVerification(
          this.clock.now(),
          this.config.verifyLeaseSeconds,
        );
        if (upload === null) break;
        const lease = verificationLeaseGuard(
          this.repository,
          upload,
          this.clock,
          this.config.verifyLeaseSeconds,
          this.config.verifyDeadlineSeconds,
        );
        try {
          const metadata = await this.verifier.verify(upload, { signal: lease.signal });
          if (!(await lease.fenceBeforePublish())) throw lease.signal.reason;
          await this.repository.publishVerified({
            uploadId: upload.id,
            leaseToken: upload.leaseToken,
            metadata,
            graceSeconds: this.config.deleteGraceSeconds,
            now: this.clock.now(),
          });
        } catch (caught) {
          if (caught instanceof VideoVerificationError) {
            await this.repository.failVerification(
              upload.id,
              upload.leaseToken,
              caught.code,
              this.clock.now(),
            );
          } else {
            degraded = true;
            if (upload.verificationAttemptCount >= this.config.verifyMaxAttempts) {
              const quarantined = await this.repository.quarantineVerification(
                upload.id,
                upload.leaseToken,
                caught instanceof VideoVerificationRuntimeError
                  ? 'verification_retry_exhausted'
                  : 'verification_infrastructure_exhausted',
                this.clock.now(),
              );
              if (!quarantined)
                throw new Error('Video verification lease was lost before quarantine.');
            } else {
              const now = this.clock.now();
              const retried = await this.repository.retryVerification(
                upload.id,
                upload.leaseToken,
                'verification_transient_failure',
                new Date(now.getTime() + retryDelayMs(upload.verificationAttemptCount)),
                now,
              );
              if (!retried)
                throw new Error('Video verification lease was lost before retry scheduling.');
            }
          }
        } finally {
          await lease.stop();
        }
        processed += 1;
      }
      const healthy = await this.repository.finalizeVerificationRun(this.clock.now(), degraded);
      if (!healthy) {
        failedHeartbeatRecorded = true;
        throw new Error('Video upload worker completed in degraded state.');
      }
      return { processed, expired };
    } catch (caught) {
      if (!failedHeartbeatRecorded)
        await this.repository.updateHeartbeat(
          'upload_verifier',
          'failed',
          this.clock.now(),
          'worker_failed',
        );
      throw caught instanceof Error ? caught : new Error('Video upload worker failed.');
    }
  }
}

export class VideoMediaCleanupService {
  public constructor(
    private readonly repository: VideoAdminRepository,
    private readonly storage: VideoStorage,
    private readonly clock: Clock,
    private readonly deadlineSeconds = 300,
  ) {}
  public async runOnce(limit = 100): Promise<{ completed: number; retried: number }> {
    await this.repository.updateHeartbeat('media_cleanup', 'started', this.clock.now());
    const controller = new AbortController();
    const deadline = setTimeout(
      () => controller.abort(new Error('Video cleanup deadline exceeded.')),
      this.deadlineSeconds * 1000,
    );
    let completed = 0;
    let retried = 0;
    let degraded = false;
    let failedHeartbeatRecorded = false;
    try {
      const jobs = await this.repository.claimDeletionJobs(this.clock.now(), limit);
      for (const job of jobs) {
        try {
          if (await this.repository.isObjectReferenced(job.objectKey)) {
            await this.repository.retryDeletion(
              job.id,
              'object_still_referenced',
              new Date(this.clock.now().getTime() + retryDelayMs(job.attemptCount)),
            );
            retried += 1;
            continue;
          }
          const multipartUploadId = job.multipartUploadId;
          if (multipartUploadId !== null)
            await awaitWithSignal(
              () =>
                this.storage.abortMultipart(job.objectKey, multipartUploadId, controller.signal),
              controller.signal,
            );
          if (job.versionId === null) {
            const versions = await awaitWithSignal(
              () => this.storage.listExactObjectVersions(job.objectKey, controller.signal),
              controller.signal,
            );
            if (versions.length === 0) {
              const current = await awaitWithSignal(
                () => this.storage.headObject(job.objectKey, null, controller.signal),
                controller.signal,
              );
              if (current !== null)
                await awaitWithSignal(
                  () => this.storage.deleteObject(job.objectKey, null, controller.signal),
                  controller.signal,
                );
            } else {
              for (const versionId of versions)
                await awaitWithSignal(
                  () => this.storage.deleteObject(job.objectKey, versionId, controller.signal),
                  controller.signal,
                );
            }
            if (
              (
                await awaitWithSignal(
                  () => this.storage.listExactObjectVersions(job.objectKey, controller.signal),
                  controller.signal,
                )
              ).length !== 0 ||
              (await awaitWithSignal(
                () => this.storage.headObject(job.objectKey, null, controller.signal),
                controller.signal,
              )) !== null
            ) {
              throw new Error('Object version cleanup was not confirmed.');
            }
          } else {
            await awaitWithSignal(
              () => this.storage.deleteObject(job.objectKey, job.versionId, controller.signal),
              controller.signal,
            );
            if (
              (
                await awaitWithSignal(
                  () => this.storage.listExactObjectVersions(job.objectKey, controller.signal),
                  controller.signal,
                )
              ).includes(job.versionId)
            )
              throw new Error('Exact object version cleanup was not confirmed.');
          }
          await this.repository.completeDeletion(job.id, this.clock.now());
          completed += 1;
        } catch {
          degraded = true;
          await this.repository.retryDeletion(
            job.id,
            'object_cleanup_failed',
            new Date(this.clock.now().getTime() + retryDelayMs(job.attemptCount)),
          );
          retried += 1;
        }
      }
      const healthy = await this.repository.finalizeCleanupRun(this.clock.now(), degraded);
      if (!healthy) {
        failedHeartbeatRecorded = true;
        throw new Error('Video cleanup worker completed in degraded state.');
      }
      return { completed, retried };
    } catch (caught) {
      if (!failedHeartbeatRecorded)
        await this.repository.updateHeartbeat(
          'media_cleanup',
          'failed',
          this.clock.now(),
          'worker_failed',
        );
      throw caught instanceof Error ? caught : new Error('Video cleanup worker failed.');
    } finally {
      clearTimeout(deadline);
    }
  }
}
