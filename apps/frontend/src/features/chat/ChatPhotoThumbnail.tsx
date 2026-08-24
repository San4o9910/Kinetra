import React, { useRef, type ReactNode } from 'react';

import type { ChatPhotoAccessDto, ChatPhotoDto } from './types';
import { usePhotoAccessLifecycle } from './usePhotoAccessLifecycle';

export interface ChatPhotoOpenRequest {
  readonly photo: ChatPhotoDto;
  readonly access: ChatPhotoAccessDto | null;
  readonly trigger: HTMLElement;
  readonly alt: string;
}

export interface ChatPhotoThumbnailProps {
  readonly photo: ChatPhotoDto;
  readonly alt: string;
  readonly loadAccess: (photoId: string, signal?: AbortSignal) => Promise<ChatPhotoAccessDto>;
  readonly onOpen: (request: ChatPhotoOpenRequest) => void;
}

export const ChatPhotoThumbnail = ({
  photo,
  alt,
  loadAccess,
  onOpen,
}: ChatPhotoThumbnailProps): ReactNode => {
  const buttonRef = useRef<HTMLButtonElement>(null);
  const { access, status, refresh, handleImageError } = usePhotoAccessLifecycle({
    enabled: true,
    photoId: photo.id,
    loadAccess,
  });
  const loadingWithoutImage = status === 'loading' && access === null;

  return (
    <React.Fragment>
      <button
        ref={buttonRef}
        className={`chat-photo-thumbnail is-${status}`}
        data-testid="chat-photo-thumbnail"
        type="button"
        aria-label={
          status === 'error'
            ? `Повторить загрузку фотографии. ${alt}`
            : `Открыть фотографию. ${alt}`
        }
        disabled={loadingWithoutImage}
        onClick={() => {
          if (status === 'error') {
            refresh();
          } else if (buttonRef.current !== null && access !== null) {
            onOpen({ photo, access, trigger: buttonRef.current, alt });
          }
        }}
      >
        {loadingWithoutImage ? <span role="status">Загружаем фото…</span> : null}
        {status === 'loading' && access !== null ? (
          <span className="visually-hidden" role="status">
            Обновляем ссылку на фото…
          </span>
        ) : null}
        {status === 'error' ? <span role="alert">Фото не загрузилось. Повторить</span> : null}
        {access !== null && status !== 'error' ? (
          <img
            src={access.url}
            alt={alt}
            loading="lazy"
            referrerPolicy="no-referrer"
            onError={() => handleImageError(access.url)}
          />
        ) : null}
      </button>
    </React.Fragment>
  );
};
