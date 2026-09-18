import React, { useEffect, useRef, useState } from 'react';
import { apiBaseUrl } from '../../lib/api';
import { trainingApi, trainingMessage } from './api';
export const TrainingPlayer = ({
  id,
  title,
  position = 0,
  onPosition,
}: {
  id: string;
  title: string;
  position?: number;
  onPosition?: (seconds: number) => void;
}): React.ReactNode => {
  const [url, setUrl] = useState('');
  const [error, setError] = useState('');
  const [retry, setRetry] = useState(0);
  const video = useRef<HTMLVideoElement>(null);
  const resume = useRef(position);
  const wasPlaying = useRef(false);
  const lastSave = useRef(0);
  useEffect(() => {
    const controller = new AbortController();
    const refresh = () => {
      void trainingApi
        .access(id, controller.signal)
        .then((data) => {
          if (!controller.signal.aborted) {
            if (video.current) {
              resume.current = video.current.currentTime;
              wasPlaying.current = !video.current.paused;
            }
            setUrl(apiBaseUrl + data.path);
            setError('');
          }
        })
        .catch((e) => {
          if (!controller.signal.aborted) setError(trainingMessage(e));
        });
    };
    refresh();
    const timer = window.setInterval(refresh, 240_000);
    return () => {
      controller.abort();
      window.clearInterval(timer);
    };
  }, [id, retry]);
  return (
    <div className="training-player">
      {error ? (
        <p role="alert">
          {error}{' '}
          <button type="button" onClick={() => setRetry((v) => v + 1)}>
            Повторить
          </button>
        </p>
      ) : !url ? (
        <p role="status">Загружаем урок…</p>
      ) : (
        <video
          ref={video}
          src={url}
          controls
          playsInline
          preload="metadata"
          aria-label={title}
          onLoadedMetadata={() => {
            if (video.current) {
              video.current.currentTime = Math.min(resume.current, video.current.duration);
              if (wasPlaying.current) void video.current.play().catch(() => undefined);
            }
          }}
          onTimeUpdate={() => {
            if (video.current && Date.now() - lastSave.current > 15_000) {
              lastSave.current = Date.now();
              onPosition?.(Math.floor(video.current.currentTime));
            }
          }}
          onPause={() => {
            if (video.current) onPosition?.(Math.floor(video.current.currentTime));
          }}
          onError={() => setError('Не удалось воспроизвести урок. Обновите ссылку.')}
        />
      )}
    </div>
  );
};
