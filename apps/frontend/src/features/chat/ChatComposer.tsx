import React, {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type ChangeEvent,
  type FormEvent,
  type KeyboardEvent,
  type ReactNode,
} from 'react';

import {
  createComposerAcknowledgement,
  shouldClearAcknowledgedComposerDraft,
  type ChatComposerAcknowledgement,
  type ChatComposerDraftSnapshot,
} from './composerAcknowledgement';
import { clearChatDraft, loadChatDraft, saveChatDraft } from './draft';
import {
  CHAT_CAPTION_MAX_CODE_POINTS,
  CHAT_TEXT_MAX_CODE_POINTS,
  chatPhotoFailurePresentation,
  formatChatFileSize,
  validateChatPhotoBasics,
  validateChatPhotoDimensions,
  validateChatText,
} from './model';
import {
  ChatComposerPhotoUploadAttemptGate,
  chatComposerPhotoUploadFailure,
} from './photoUploadFailure';
import type {
  ChatMessageDto,
  ChatMessageRequest,
  ChatPhotoDto,
  ChatPhotoUploadResult,
  ChatUploadPhotoInput,
} from './types';

interface SelectedPhotoState {
  readonly file: File | null;
  readonly name: string;
  readonly size: number;
  readonly previewUrl: string | null;
  readonly idempotencyKey: string;
  readonly progress: number | null;
  readonly status: 'uploading' | 'ready' | 'failed';
  readonly photo: ChatPhotoDto | null;
  readonly failureCode: string | null;
  readonly retryAllowed: boolean;
  readonly error: string | null;
}

export interface ChatComposerProps {
  readonly accountId: string;
  readonly conversationId: string;
  readonly online: boolean;
  readonly disabled?: boolean;
  readonly photoUploadsEnabled?: boolean;
  readonly acknowledgement?: ChatComposerAcknowledgement | null;
  readonly uploadPhoto: (input: ChatUploadPhotoInput) => Promise<ChatPhotoUploadResult>;
  readonly getPhotoStatus: (
    photoId: string,
    signal?: AbortSignal,
  ) => Promise<ChatPhotoUploadResult>;
  readonly onSend: (request: ChatMessageRequest) => Promise<ChatMessageDto>;
  readonly registerObjectUrl?: (url: string) => () => void;
}

class ChatPhotoProcessingError extends Error {
  public constructor(
    public readonly photo: ChatPhotoDto,
    public readonly failureCode: string | null,
    public readonly retryAllowed: boolean,
    message: string,
  ) {
    super(message);
    this.name = 'ChatPhotoProcessingError';
  }
}

export interface ChatPhotoRetryButtonProps {
  readonly retryAllowed: boolean;
  readonly online: boolean;
  readonly onRetry: () => void;
}

export const ChatPhotoRetryButton = ({
  retryAllowed,
  online,
  onRetry,
}: ChatPhotoRetryButtonProps): ReactNode =>
  retryAllowed ? (
    <button data-testid="chat-photo-retry" type="button" disabled={!online} onClick={onRetry}>
      Повторить
    </button>
  ) : null;

const readPhotoDimensions = async (file: File): Promise<{ width: number; height: number }> => {
  if (typeof createImageBitmap !== 'function') {
    return { width: 1, height: 1 };
  }

  const bitmap = await createImageBitmap(file);
  try {
    return { width: bitmap.width, height: bitmap.height };
  } finally {
    bitmap.close();
  }
};

const waitForPhotoPoll = (milliseconds: number, signal: AbortSignal): Promise<void> =>
  new Promise((resolve, reject) => {
    const handleAbort = (): void => {
      window.clearTimeout(timer);
      reject(new DOMException('Photo polling was aborted.', 'AbortError'));
    };
    const timer = window.setTimeout(() => {
      signal.removeEventListener('abort', handleAbort);
      resolve();
    }, milliseconds);
    signal.addEventListener('abort', handleAbort, { once: true });
  });

const restoredPhotoState = (photo: ChatPhotoDto): SelectedPhotoState => {
  const failure = chatPhotoFailurePresentation(photo);
  return {
    file: null,
    name: 'Подготовленная фотография',
    size: photo.size_bytes ?? 0,
    previewUrl: null,
    idempotencyKey: crypto.randomUUID(),
    progress: 100,
    status:
      photo.status === 'processing' ? 'uploading' : photo.status === 'failed' ? 'failed' : 'ready',
    photo,
    failureCode: failure?.failureCode ?? null,
    retryAllowed: failure?.retryAllowed ?? true,
    error: failure?.message ?? null,
  };
};

export const ChatComposer = ({
  accountId,
  conversationId,
  online,
  disabled = false,
  photoUploadsEnabled = false,
  acknowledgement = null,
  uploadPhoto,
  getPhotoStatus,
  onSend,
  registerObjectUrl,
}: ChatComposerProps): ReactNode => {
  const initialDraft = useRef(loadChatDraft(accountId, conversationId));
  const [text, setText] = useState(initialDraft.current.text);
  const [selectedPhoto, setSelectedPhoto] = useState<SelectedPhotoState | null>(() =>
    !photoUploadsEnabled || initialDraft.current.photo === null
      ? null
      : restoredPhotoState(initialDraft.current.photo),
  );
  const [sendBusy, setSendBusy] = useState(false);
  const [composerError, setComposerError] = useState<string | null>(null);
  const [pendingRequest, setPendingRequest] = useState<ChatMessageRequest | null>(
    initialDraft.current.pendingRequest,
  );
  const fileInputRef = useRef<HTMLInputElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const uploadControllerRef = useRef<AbortController | null>(null);
  const uploadAttemptGateRef = useRef(new ChatComposerPhotoUploadAttemptGate());
  const revokePreviewRef = useRef<(() => void) | null>(null);
  const sendInFlightRef = useRef(false);
  const textRef = useRef(text);
  const selectedPhotoRef = useRef(selectedPhoto);
  const pendingRequestRef = useRef(pendingRequest);

  textRef.current = text;
  selectedPhotoRef.current = selectedPhoto;
  pendingRequestRef.current = pendingRequest;

  useLayoutEffect(() => {
    const textarea = textareaRef.current;
    if (textarea === null) {
      return;
    }

    textarea.style.height = 'auto';
    const nextHeight = Math.min(textarea.scrollHeight, 124);
    textarea.style.height = `${Math.max(nextHeight, 44)}px`;
    textarea.style.overflowY = textarea.scrollHeight > 124 ? 'auto' : 'hidden';
  }, [text]);

  const releasePreview = useCallback((): void => {
    revokePreviewRef.current?.();
    revokePreviewRef.current = null;
  }, []);

  const resetDraft = useCallback((): void => {
    uploadControllerRef.current?.abort();
    uploadControllerRef.current = null;
    if (selectedPhotoRef.current !== null) {
      uploadAttemptGateRef.current.forget(selectedPhotoRef.current.idempotencyKey);
    }
    releasePreview();
    textRef.current = '';
    selectedPhotoRef.current = null;
    pendingRequestRef.current = null;
    setText('');
    setSelectedPhoto(null);
    setPendingRequest(null);
    setComposerError(null);
    clearChatDraft(accountId, conversationId);
    if (fileInputRef.current !== null) {
      fileInputRef.current.value = '';
    }
  }, [accountId, conversationId, releasePreview]);

  const currentDraftSnapshot = useCallback(
    (): ChatComposerDraftSnapshot => ({
      text: textRef.current,
      photoId:
        selectedPhotoRef.current?.status === 'ready'
          ? (selectedPhotoRef.current.photo?.id ?? null)
          : null,
    }),
    [],
  );

  useEffect(() => {
    if (
      acknowledgement !== null &&
      shouldClearAcknowledgedComposerDraft(
        acknowledgement,
        pendingRequestRef.current,
        currentDraftSnapshot(),
      )
    ) {
      resetDraft();
    }
  }, [acknowledgement, currentDraftSnapshot, resetDraft]);

  useEffect(
    () => () => {
      uploadControllerRef.current?.abort();
      releasePreview();
    },
    [releasePreview],
  );

  useEffect(() => {
    if (photoUploadsEnabled) {
      return;
    }

    uploadControllerRef.current?.abort();
    uploadControllerRef.current = null;
    if (selectedPhotoRef.current !== null) {
      uploadAttemptGateRef.current.forget(selectedPhotoRef.current.idempotencyKey);
    }
    releasePreview();
    selectedPhotoRef.current = null;
    setSelectedPhoto(null);
    if (pendingRequestRef.current?.kind === 'photo') {
      pendingRequestRef.current = null;
      setPendingRequest(null);
    }
    if (fileInputRef.current !== null) {
      fileInputRef.current.value = '';
    }
  }, [photoUploadsEnabled, releasePreview]);

  useEffect(() => {
    saveChatDraft(accountId, conversationId, {
      text,
      photo: selectedPhoto?.status === 'ready' ? selectedPhoto.photo : null,
      pendingRequest,
    });
  }, [accountId, conversationId, pendingRequest, selectedPhoto, text]);

  const runUpload = useCallback(
    (photoState: SelectedPhotoState): void => {
      if (
        photoState.file === null ||
        !online ||
        !uploadAttemptGateRef.current.beginAttempt(photoState.idempotencyKey, photoState)
      ) {
        return;
      }

      uploadControllerRef.current?.abort();
      const controller = new AbortController();
      uploadControllerRef.current = controller;
      setSelectedPhoto({
        ...photoState,
        progress: 0,
        status: 'uploading',
        error: null,
      });

      const uploadAndRecover = async (): Promise<ChatPhotoDto> => {
        const uploaded = await uploadPhoto({
          file: photoState.file as File,
          idempotencyKey: photoState.idempotencyKey,
          signal: controller.signal,
          onProgress: (progress) => {
            if (!controller.signal.aborted) {
              setSelectedPhoto((current) =>
                current?.idempotencyKey === photoState.idempotencyKey
                  ? { ...current, progress }
                  : current,
              );
            }
          },
        });
        let photo = uploaded.photo;
        let retryAfterSeconds = uploaded.retry_after_seconds ?? 1;

        for (let attempt = 0; photo.status === 'processing' && attempt < 30; attempt += 1) {
          setSelectedPhoto((current) =>
            current?.idempotencyKey === photoState.idempotencyKey
              ? { ...current, progress: null, photo }
              : current,
          );
          await waitForPhotoPoll(
            Math.max(250, Math.min(5_000, retryAfterSeconds * 1_000)),
            controller.signal,
          );
          const status = await getPhotoStatus(photo.id, controller.signal);
          photo = status.photo;
          retryAfterSeconds = status.retry_after_seconds ?? 1;
        }

        if (photo.status === 'processing') {
          throw new Error('Фотография обрабатывается слишком долго. Повторите попытку.');
        }

        if (photo.status === 'failed') {
          const failure = chatPhotoFailurePresentation(photo);
          if (failure === null) {
            throw new Error('Не удалось безопасно обработать фотографию. Выберите другой файл.');
          }
          throw new ChatPhotoProcessingError(
            photo,
            failure.failureCode,
            failure.retryAllowed,
            failure.message,
          );
        }

        return photo;
      };

      void uploadAndRecover()
        .then((photo) => {
          if (!controller.signal.aborted) {
            uploadAttemptGateRef.current.finishAttempt(photoState.idempotencyKey);
            setSelectedPhoto((current) =>
              current?.idempotencyKey === photoState.idempotencyKey
                ? {
                    ...current,
                    progress: 100,
                    status: 'ready',
                    photo,
                    failureCode: null,
                    retryAllowed: true,
                    error: null,
                  }
                : current,
            );
          }
        })
        .catch((error: unknown) => {
          if (!controller.signal.aborted) {
            const failure =
              error instanceof ChatPhotoProcessingError
                ? {
                    failureCode: error.failureCode,
                    retryAllowed: error.retryAllowed,
                    message: error.message,
                  }
                : chatComposerPhotoUploadFailure(error);
            uploadAttemptGateRef.current.finishAttempt(photoState.idempotencyKey, failure);
            setSelectedPhoto((current) =>
              current?.idempotencyKey === photoState.idempotencyKey
                ? {
                    ...current,
                    status: 'failed',
                    ...(error instanceof ChatPhotoProcessingError ? { photo: error.photo } : {}),
                    failureCode: failure.failureCode,
                    retryAllowed: failure.retryAllowed,
                    error: failure.message,
                  }
                : current,
            );
          }
        })
        .finally(() => {
          uploadAttemptGateRef.current.finishAttempt(photoState.idempotencyKey);
          if (uploadControllerRef.current === controller) {
            uploadControllerRef.current = null;
          }
        });
    },
    [getPhotoStatus, online, uploadPhoto],
  );

  const selectPhoto = async (event: ChangeEvent<HTMLInputElement>): Promise<void> => {
    const file = event.currentTarget.files?.[0];
    if (file === undefined) {
      return;
    }

    setComposerError(null);
    const basics = validateChatPhotoBasics(file);
    if (!basics.valid) {
      setComposerError(basics.error);
      event.currentTarget.value = '';
      return;
    }

    try {
      const dimensions = await readPhotoDimensions(file);
      const validDimensions = validateChatPhotoDimensions(dimensions.width, dimensions.height);
      if (!validDimensions.valid) {
        setComposerError(validDimensions.error);
        event.currentTarget.value = '';
        return;
      }
    } catch {
      setComposerError('Не удалось прочитать фотографию. Выберите другой файл.');
      event.currentTarget.value = '';
      return;
    }

    uploadControllerRef.current?.abort();
    releasePreview();
    const previewUrl = URL.createObjectURL(file);
    revokePreviewRef.current =
      registerObjectUrl?.(previewUrl) ?? (() => URL.revokeObjectURL(previewUrl));
    const nextPhoto: SelectedPhotoState = {
      file,
      name: file.name,
      size: file.size,
      previewUrl,
      idempotencyKey: crypto.randomUUID(),
      progress: 0,
      status: 'uploading',
      photo: null,
      failureCode: null,
      retryAllowed: true,
      error: null,
    };
    selectedPhotoRef.current = nextPhoto;
    pendingRequestRef.current = null;
    setSelectedPhoto(nextPhoto);
    setPendingRequest(null);
    runUpload(nextPhoto);
  };

  const removePhoto = (): void => {
    uploadControllerRef.current?.abort();
    uploadControllerRef.current = null;
    if (selectedPhotoRef.current !== null) {
      uploadAttemptGateRef.current.forget(selectedPhotoRef.current.idempotencyKey);
    }
    releasePreview();
    selectedPhotoRef.current = null;
    pendingRequestRef.current = null;
    setSelectedPhoto(null);
    setPendingRequest(null);
    setComposerError(null);
    if (fileInputRef.current !== null) {
      fileInputRef.current.value = '';
    }
  };

  const maximumTextLength =
    selectedPhoto === null ? CHAT_TEXT_MAX_CODE_POINTS : CHAT_CAPTION_MAX_CODE_POINTS;
  const validation = validateChatText(text, maximumTextLength, selectedPhoto !== null);
  const photoReady =
    selectedPhoto === null || (selectedPhoto.status === 'ready' && selectedPhoto.photo !== null);
  const canSend =
    online &&
    !disabled &&
    !sendBusy &&
    photoReady &&
    validation.valid &&
    (selectedPhoto !== null || validation.codePointLength > 0);

  const submit = async (event?: FormEvent<HTMLFormElement>): Promise<void> => {
    event?.preventDefault();
    if (!canSend || sendInFlightRef.current) {
      if (!online) {
        setComposerError('Нет сети. Черновик сохранён в этой вкладке.');
      } else if (!validation.valid) {
        setComposerError(validation.error);
      }
      return;
    }

    let request: ChatMessageRequest;
    if (selectedPhoto === null) {
      request =
        pendingRequest?.kind === 'text' && pendingRequest.text === validation.value
          ? pendingRequest
          : {
              client_message_id: crypto.randomUUID(),
              kind: 'text',
              text: validation.value,
            };
    } else {
      const readyPhoto = selectedPhoto.photo;
      if (readyPhoto === null) {
        setComposerError('Дождитесь завершения обработки фотографии.');
        return;
      }
      const caption = validation.value.length === 0 ? null : validation.value;
      request =
        pendingRequest?.kind === 'photo' &&
        pendingRequest.text === caption &&
        pendingRequest.photo_id === readyPhoto.id
          ? pendingRequest
          : {
              client_message_id: crypto.randomUUID(),
              kind: 'photo',
              text: caption,
              photo_id: readyPhoto.id,
            };
    }

    pendingRequestRef.current = request;
    setPendingRequest(request);
    saveChatDraft(accountId, conversationId, {
      text,
      photo: selectedPhoto?.status === 'ready' ? selectedPhoto.photo : null,
      pendingRequest: request,
    });
    sendInFlightRef.current = true;
    setSendBusy(true);
    setComposerError(null);
    try {
      const canonical = await onSend(request);
      const sentAcknowledgement = createComposerAcknowledgement(canonical, request, 0);
      if (
        sentAcknowledgement !== null &&
        shouldClearAcknowledgedComposerDraft(
          sentAcknowledgement,
          pendingRequestRef.current,
          currentDraftSnapshot(),
        )
      ) {
        resetDraft();
      }
    } catch (error) {
      setComposerError(
        error instanceof Error
          ? error.message
          : 'Не удалось отправить. Используйте «Повторить» у сообщения.',
      );
    } finally {
      sendInFlightRef.current = false;
      setSendBusy(false);
    }
  };

  const handleKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>): void => {
    if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
      event.preventDefault();
      void submit();
    }
  };

  return (
    <React.Fragment>
      <form
        className="chat-composer"
        data-testid="chat-composer"
        aria-label="Новое сообщение"
        onSubmit={(event) => void submit(event)}
      >
        {!online ? (
          <p className="chat-offline-note" data-testid="chat-offline-note" role="status">
            Нет сети. Черновик останется в этой вкладке.
          </p>
        ) : null}

        {selectedPhoto === null ? null : (
          <section
            className="chat-photo-draft"
            data-testid="chat-photo-draft"
            aria-label="Фотография"
          >
            {selectedPhoto.previewUrl === null ? (
              <span className="chat-photo-draft-placeholder" aria-hidden="true">
                Фото
              </span>
            ) : (
              <img src={selectedPhoto.previewUrl} alt="Предпросмотр выбранной фотографии" />
            )}
            <div className="chat-photo-draft-copy">
              <strong>{selectedPhoto.name}</strong>
              <span>
                {selectedPhoto.size > 0
                  ? formatChatFileSize(selectedPhoto.size)
                  : 'Фото подготовлено'}
              </span>
              {selectedPhoto.status === 'uploading' ? (
                <span role="status">
                  {selectedPhoto.progress === null
                    ? 'Обрабатываем фотографию…'
                    : `Загружаем: ${Math.round(selectedPhoto.progress)}%`}
                </span>
              ) : null}
              {selectedPhoto.error === null ? null : (
                <span className="chat-photo-draft-error" role="alert">
                  {selectedPhoto.error}
                </span>
              )}
            </div>
            <div className="chat-photo-draft-actions">
              {selectedPhoto.status === 'failed' && selectedPhoto.file !== null ? (
                <ChatPhotoRetryButton
                  retryAllowed={selectedPhoto.retryAllowed}
                  online={online}
                  onRetry={() => runUpload(selectedPhoto)}
                />
              ) : null}
              <button data-testid="chat-photo-remove" type="button" onClick={removePhoto}>
                Удалить
              </button>
            </div>
          </section>
        )}

        <div className={`chat-composer-row${photoUploadsEnabled ? ' has-attachment' : ''}`}>
          {photoUploadsEnabled ? (
            <React.Fragment>
              <input
                ref={fileInputRef}
                className="visually-hidden"
                data-testid="chat-photo-input"
                type="file"
                accept="image/jpeg,image/png,image/webp"
                disabled={!online || disabled || selectedPhoto !== null}
                onChange={(event) => void selectPhoto(event)}
              />
              <button
                className="chat-attachment-button"
                data-testid="chat-attachment-button"
                type="button"
                aria-label="Добавить фотографию"
                disabled={!online || disabled || selectedPhoto !== null}
                onClick={() => fileInputRef.current?.click()}
              >
                <span aria-hidden="true">＋</span>
              </button>
            </React.Fragment>
          ) : null}
          <label className="chat-composer-input">
            <span className="visually-hidden">
              {selectedPhoto === null ? 'Сообщение' : 'Подпись к фотографии'}
            </span>
            <textarea
              ref={textareaRef}
              data-testid="chat-message-input"
              rows={1}
              value={text}
              placeholder={selectedPhoto === null ? 'Напишите сообщение' : 'Добавьте подпись'}
              disabled={disabled}
              onChange={(event) => {
                const nextText = event.currentTarget.value;
                textRef.current = nextText;
                if (pendingRequestRef.current !== null) {
                  pendingRequestRef.current = null;
                  setPendingRequest(null);
                }
                setText(nextText);
                setComposerError(null);
              }}
              onKeyDown={handleKeyDown}
            />
          </label>
          <button
            className="chat-send-button"
            data-testid="chat-send-button"
            type="submit"
            aria-label="Отправить сообщение"
            disabled={!canSend}
          >
            {sendBusy ? '…' : 'Отправить'}
          </button>
        </div>

        {validation.codePointLength > maximumTextLength ? (
          <p className="chat-composer-error" role="alert">
            {validation.error}
          </p>
        ) : null}
        {composerError === null ? null : (
          <p className="chat-composer-error" data-testid="chat-composer-error" role="alert">
            {composerError}
          </p>
        )}
      </form>
    </React.Fragment>
  );
};
