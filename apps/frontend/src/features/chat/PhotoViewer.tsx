import React, { useCallback, useEffect, useRef, type ReactNode } from 'react';

import type { ChatPhotoAccessDto, ChatPhotoDto } from './types';
import { usePhotoAccessLifecycle } from './usePhotoAccessLifecycle';

export interface PhotoViewerProps {
  readonly open: boolean;
  readonly photo: ChatPhotoDto | null;
  readonly alt: string;
  readonly initialAccess?: ChatPhotoAccessDto | null;
  readonly returnFocusElement?: HTMLElement | null;
  readonly loadAccess: (photoId: string, signal?: AbortSignal) => Promise<ChatPhotoAccessDto>;
  readonly onClose: () => void;
}

const viewerHistoryKey = 'kinetraChatPhotoViewer';

export const PhotoViewer = ({
  open,
  photo,
  alt,
  initialAccess = null,
  returnFocusElement = null,
  loadAccess,
  onClose,
}: PhotoViewerProps): ReactNode => {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const viewerIdRef = useRef(`viewer-${Math.random().toString(36).slice(2)}`);
  const ownedHistoryRef = useRef(false);
  const wasOpenRef = useRef(false);
  const { access, status, error, refresh, handleImageError } = usePhotoAccessLifecycle({
    enabled: open && photo !== null,
    photoId: photo?.id ?? null,
    initialAccess,
    loadAccess,
  });

  const requestClose = useCallback((): void => {
    if (
      ownedHistoryRef.current &&
      window.history.state?.[viewerHistoryKey] === viewerIdRef.current
    ) {
      window.history.back();
      return;
    }

    onClose();
  }, [onClose]);

  useEffect(() => {
    const dialog = dialogRef.current;
    if (dialog === null) {
      return;
    }

    if (open && !dialog.open) {
      dialog.showModal();
    } else if (!open && dialog.open) {
      dialog.close();
    }
  }, [open]);

  useEffect(() => {
    if (!open || photo === null) {
      return undefined;
    }

    if (!wasOpenRef.current) {
      wasOpenRef.current = true;
      window.history.pushState(
        { ...window.history.state, [viewerHistoryKey]: viewerIdRef.current },
        '',
        window.location.href,
      );
      ownedHistoryRef.current = true;
    }

    const handlePopState = (): void => {
      if (window.history.state?.[viewerHistoryKey] !== viewerIdRef.current) {
        ownedHistoryRef.current = false;
        onClose();
      }
    };
    window.addEventListener('popstate', handlePopState);

    return () => window.removeEventListener('popstate', handlePopState);
  }, [onClose, open, photo]);

  useEffect(() => {
    if (open) {
      return;
    }

    if (wasOpenRef.current) {
      wasOpenRef.current = false;
      ownedHistoryRef.current = false;
      window.requestAnimationFrame(() => returnFocusElement?.focus());
    }
  }, [open, returnFocusElement]);

  return (
    <React.Fragment>
      <dialog
        ref={dialogRef}
        className="chat-photo-viewer"
        data-testid="chat-photo-viewer"
        aria-label="Просмотр фотографии"
        onCancel={(event) => {
          event.preventDefault();
          requestClose();
        }}
      >
        <div className="chat-photo-viewer-toolbar">
          <button
            className="chat-photo-viewer-close"
            data-testid="chat-photo-viewer-close"
            type="button"
            aria-label="Закрыть фотографию"
            onClick={requestClose}
          >
            Закрыть
          </button>
        </div>
        <div className="chat-photo-viewer-content">
          {status === 'loading' ? <p role="status">Загружаем фотографию…</p> : null}
          {status === 'error' ? (
            <div>
              <p role="alert">
                {error instanceof Error
                  ? error.message
                  : 'Не удалось открыть фотографию. Попробуйте ещё раз.'}
              </p>
              <button type="button" onClick={refresh}>
                Повторить загрузку
              </button>
            </div>
          ) : null}
          {access !== null && status !== 'error' ? (
            <img
              src={access.url}
              alt={alt}
              referrerPolicy="no-referrer"
              onError={() => handleImageError(access.url)}
            />
          ) : null}
        </div>
      </dialog>
    </React.Fragment>
  );
};
