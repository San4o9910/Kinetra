import { canRetryChatPhotoUpload } from './model';
import type { ChatPhotoDto } from './types';

export const CHAT_PHOTO_RETRY_EXHAUSTED_MESSAGE =
  'Повторные попытки обработки исчерпаны. Удалите фотографию и выберите другой файл.';

export interface ChatComposerPhotoUploadFailure {
  readonly failureCode: string | null;
  readonly retryAllowed: boolean;
  readonly message: string;
}

interface CodedPhotoUploadError {
  readonly code: string;
}

const isCodedPhotoUploadError = (error: unknown): error is CodedPhotoUploadError =>
  typeof error === 'object' && error !== null && 'code' in error && typeof error.code === 'string';

const uploadErrorMessage = (error: unknown): string =>
  error instanceof Error ? error.message : 'Не удалось загрузить фотографию. Попробуйте ещё раз.';

export const chatComposerPhotoUploadFailure = (error: unknown): ChatComposerPhotoUploadFailure =>
  isCodedPhotoUploadError(error) && error.code === 'CHAT_PHOTO_RETRY_EXHAUSTED'
    ? {
        failureCode: error.code,
        retryAllowed: false,
        message: CHAT_PHOTO_RETRY_EXHAUSTED_MESSAGE,
      }
    : {
        failureCode: null,
        retryAllowed: true,
        message: uploadErrorMessage(error),
      };

export interface ChatComposerPhotoRetryCandidate {
  readonly status: 'uploading' | 'ready' | 'failed';
  readonly retryAllowed: boolean;
  readonly photo: ChatPhotoDto | null;
}

export const canAttemptChatComposerPhotoUpload = (
  candidate: ChatComposerPhotoRetryCandidate,
): boolean =>
  candidate.status !== 'failed' ||
  (candidate.retryAllowed && canRetryChatPhotoUpload(candidate.photo));

export class ChatComposerPhotoUploadAttemptGate {
  private readonly inFlightKeys = new Set<string>();
  private readonly exhaustedKeys = new Set<string>();

  public beginAttempt(idempotencyKey: string, candidate: ChatComposerPhotoRetryCandidate): boolean {
    if (
      this.inFlightKeys.has(idempotencyKey) ||
      this.exhaustedKeys.has(idempotencyKey) ||
      !canAttemptChatComposerPhotoUpload(candidate)
    ) {
      return false;
    }

    this.inFlightKeys.add(idempotencyKey);
    return true;
  }

  public finishAttempt(idempotencyKey: string, failure?: ChatComposerPhotoUploadFailure): void {
    this.inFlightKeys.delete(idempotencyKey);
    if (failure?.retryAllowed === false) {
      this.exhaustedKeys.add(idempotencyKey);
    }
  }

  public forget(idempotencyKey: string): void {
    this.inFlightKeys.delete(idempotencyKey);
    this.exhaustedKeys.delete(idempotencyKey);
  }
}
