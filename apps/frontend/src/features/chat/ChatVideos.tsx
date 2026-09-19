import React from 'react';
import { useCallback, useEffect, useRef, useState } from 'react';
import type { ChatVideosResponse } from '@kinetra/shared';
import { ApiRequestError, getChatVideos, uploadChatVideo } from '../../lib/api';

export const ChatVideos = ({
  conversationId,
  accountId,
  online,
}: {
  readonly conversationId: string;
  readonly accountId: string;
  readonly online: boolean;
}): React.ReactNode => {
  const [data, setData] = useState<ChatVideosResponse | null>(null);
  const [file, setFile] = useState<File | null>(null);
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const uploadId = useRef<string | null>(null);
  const gate = useRef(false);
  const controller = useRef<AbortController | null>(null);
  const input = useRef<HTMLInputElement>(null);
  const mounted = useRef(true);
  const load = useCallback(
    async (signal?: AbortSignal): Promise<void> => {
      try {
        const value = await getChatVideos(conversationId, signal);
        if (!signal?.aborted && mounted.current) setData(value);
      } catch {
        if (!signal?.aborted && mounted.current)
          setError('Не удалось загрузить видео. Повторите обновление.');
      }
    },
    [conversationId],
  );
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      controller.current?.abort();
    };
  }, []);
  useEffect(() => {
    if (!open || !online) return;
    const current = new AbortController();
    void load(current.signal);
    const timer = window.setInterval(() => {
      if (document.visibilityState === 'visible') void load(current.signal);
    }, 180_000);
    return () => {
      current.abort();
      window.clearInterval(timer);
    };
  }, [open, online, load]);
  const send = async (): Promise<void> => {
    if (gate.current || file === null || !online) return;
    gate.current = true;
    setBusy(true);
    setError(null);
    setNotice(null);
    const current = new AbortController();
    controller.current = current;
    const id = uploadId.current ?? crypto.randomUUID();
    uploadId.current = id;
    try {
      await uploadChatVideo(conversationId, file, id, current.signal);
      if (mounted.current) {
        setFile(null);
        uploadId.current = null;
        if (input.current !== null) input.current.value = '';
        setNotice('Видео отправлено в диалог.');
        await load(current.signal);
      }
    } catch (caught) {
      if (!current.signal.aborted && mounted.current)
        setError(
          caught instanceof ApiRequestError
            ? caught.message
            : 'Видео не отправлено. Повторите попытку.',
        );
    } finally {
      gate.current = false;
      if (mounted.current) setBusy(false);
    }
  };
  return (
    <details className="chat-videos" onToggle={(event) => setOpen(event.currentTarget.open)}>
      <summary>Видео в диалоге</summary>
      <p>Отправьте короткое видео для обратной связи. До 3 минут, MP4 или MOV, до 32 МБ.</p>
      {data === null ? (
        <p role="status">Открываем видео…</p>
      ) : !data.available ? (
        <p>Отправка видео пока недоступна.</p>
      ) : (
        <>
          <div className="chat-video-list">
            {data.videos.map((video) => (
              <article key={video.id}>
                <span>
                  {video.uploader_user_id === accountId ? 'Вы' : 'Собеседник'} ·{' '}
                  {new Date(video.created_at).toLocaleDateString('ru-RU')} ·{' '}
                  {video.duration_seconds} сек
                </span>
                <video
                  src={video.url}
                  controls
                  playsInline
                  preload="none"
                  aria-label="Видео из диалога"
                />
              </article>
            ))}
          </div>
          <label>
            Выбрать видео
            <input
              ref={input}
              type="file"
              accept="video/mp4,video/quicktime,.mp4,.mov"
              disabled={busy || !online}
              onChange={(event) => {
                const selected = event.target.files?.[0];
                setError(null);
                setNotice(null);
                uploadId.current = null;
                if (
                  selected !== undefined &&
                  selected.size > 0 &&
                  selected.size <= 33554432 &&
                  ['video/mp4', 'video/quicktime'].includes(selected.type)
                )
                  setFile(selected);
                else {
                  setFile(null);
                  event.target.value = '';
                  setError('Выберите MP4 или MOV до 32 МБ.');
                }
              }}
            />
          </label>
          {file !== null && (
            <button
              type="button"
              className="primary-button"
              disabled={busy || !online}
              onClick={() => void send()}
            >
              {busy ? 'Отправляем и обрабатываем…' : 'Отправить видео'}
            </button>
          )}
        </>
      )}
      {notice !== null && <p role="status">{notice}</p>}
      {error !== null && <p role="alert">{error}</p>}
      <button
        type="button"
        className="secondary-button"
        disabled={busy || !online}
        onClick={() => {
          setError(null);
          void load();
        }}
      >
        Обновить видео
      </button>
    </details>
  );
};
