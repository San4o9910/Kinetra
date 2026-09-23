import { KinetraVideoIntro } from '../navigation/KinetraVideoIntro';
import React, { useEffect, useRef, useState } from 'react';
import { apiBaseUrl } from '../../lib/api';
import { trainingApi, trainingMessage } from './api';
const signatureUrl = new URL('../../assets/brand/kinetra-signature.mp3', import.meta.url).href;
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
  const [phase, setPhase] = useState<'ready' | 'intro' | 'playing'>('ready');
  const [needsPlay, setNeedsPlay] = useState(false);
  const [url, setUrl] = useState('');
  const [error, setError] = useState('');
  const [retry, setRetry] = useState(0);
  const video = useRef<HTMLVideoElement>(null);
  const signature = useRef<HTMLAudioElement>(null);
  const resume = useRef(position);
  const wasPlaying = useRef(false);
  const lastSave = useRef(0);
  useEffect(() => {
    const audio = signature.current;
    return () => {
      audio?.pause();
    };
  }, []);
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
  const play = () => {
    signature.current?.pause();
    setPhase('playing');
    requestAnimationFrame(() => video.current?.focus({ preventScroll: true }));
    setNeedsPlay(false);
    if (video.current) void video.current.play().catch(() => setNeedsPlay(true));
  };
  return (
    <div className="training-player">
      <audio
        ref={signature}
        src={signatureUrl}
        preload="auto"
        aria-hidden="true"
        data-testid="intro-audio"
      />
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
        <>
          {phase === 'ready' && (
            <div className="training-video-launch">
              <strong>{title}</strong>
              <button
                type="button"
                className="primary-button"
                data-testid="lesson-start"
                onClick={() => {
                  if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) play();
                  else {
                    const audio = signature.current;
                    if (audio) {
                      audio.currentTime = 0;
                      audio.volume = 0.7;
                      try {
                        audio.muted = localStorage.getItem('kinetra-intro-sound') === 'off';
                      } catch {
                        audio.muted = false;
                      }
                      // Play in the original user gesture, including on iOS. A denial never blocks the lesson.
                      if (!audio.muted) void audio.play().catch(() => undefined);
                    }
                    setPhase('intro');
                  }
                }}
              >
                ▶ Воспроизвести урок
              </button>
            </div>
          )}
          {phase === 'intro' && <KinetraVideoIntro onDone={play} sound={signature.current} />}
          {needsPlay && (
            <button type="button" className="primary-button" onClick={play}>
              Воспроизвести видео
            </button>
          )}
          <video
            ref={video}
            hidden={phase !== 'playing'}
            src={url}
            tabIndex={0}
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
        </>
      )}
    </div>
  );
};
