import { useCallback, useEffect, useRef, useState } from 'react';

import {
  ChatPhotoAccessLifecycle,
  type ChatPhotoAccessLifecycleState,
} from './photoAccessLifecycle';
import type { ChatPhotoAccessDto } from './types';

const idleState = (): ChatPhotoAccessLifecycleState => ({
  photoId: null,
  status: 'idle',
  access: null,
  error: null,
});

export interface UsePhotoAccessLifecycleInput {
  readonly enabled: boolean;
  readonly photoId: string | null;
  readonly initialAccess?: ChatPhotoAccessDto | null;
  readonly loadAccess: (photoId: string, signal?: AbortSignal) => Promise<ChatPhotoAccessDto>;
}

export interface UsePhotoAccessLifecycleValue extends ChatPhotoAccessLifecycleState {
  readonly refresh: () => void;
  readonly handleImageError: (url: string) => void;
}

export const usePhotoAccessLifecycle = ({
  enabled,
  photoId,
  initialAccess = null,
  loadAccess,
}: UsePhotoAccessLifecycleInput): UsePhotoAccessLifecycleValue => {
  const [state, setState] = useState<ChatPhotoAccessLifecycleState>(() =>
    enabled && photoId !== null
      ? { photoId, status: 'loading', access: null, error: null }
      : idleState(),
  );
  const lifecycleRef = useRef<ChatPhotoAccessLifecycle | null>(null);

  useEffect(() => {
    lifecycleRef.current?.stop();
    lifecycleRef.current = null;

    if (!enabled || photoId === null) {
      setState(idleState());
      return undefined;
    }

    const lifecycle = new ChatPhotoAccessLifecycle({
      photoId,
      loadAccess,
      onStateChange: setState,
    });
    lifecycleRef.current = lifecycle;
    lifecycle.start(initialAccess);

    return () => {
      lifecycle.stop();
      if (lifecycleRef.current === lifecycle) {
        lifecycleRef.current = null;
      }
    };
  }, [enabled, initialAccess, loadAccess, photoId]);

  const refresh = useCallback((): void => lifecycleRef.current?.refresh(), []);
  const handleImageError = useCallback(
    (url: string): void => lifecycleRef.current?.handleImageError(url),
    [],
  );

  const visibleState =
    !enabled || photoId === null
      ? idleState()
      : state.photoId !== photoId
        ? { photoId, status: 'loading' as const, access: null, error: null }
        : state;

  return { ...visibleState, refresh, handleImageError };
};
