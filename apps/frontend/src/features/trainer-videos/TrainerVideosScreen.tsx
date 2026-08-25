import { useCallback, useEffect, useRef, useState, type ChangeEvent, type ReactNode } from 'react';
import type { TrainerVideoProgramResponse, TrainerVideoSlotDto } from '@kinetra/shared';

import {
  ApiRequestError,
  cancelTrainerVideoUpload,
  getTrainerVideoPreview,
  getTrainerVideoProgram,
  getTrainerVideoUpload,
  unpublishTrainerVideo,
} from '../../lib/api';
import { validateTrainerVideoProgram, videoFailureText, videoStatusText } from './model';
import {
  createTrainerVideoProgramPollingController,
  type TrainerVideoProgramPollingController,
} from './program-polling';
import { uploadWorkoutVideo } from './upload';

export interface TrainerVideosScreenProps {
  readonly online: boolean;
  readonly onSessionExpired: () => void;
}

export const TrainerVideosScreen = ({
  online,
  onSessionExpired,
}: TrainerVideosScreenProps): ReactNode => {
  const [program, setProgram] = useState<TrainerVideoProgramResponse | null>(null);
  const [selectedWeek, setSelectedWeek] = useState(1);
  const [error, setError] = useState<string | null>(null);
  const [slotOperations, setSlotOperations] = useState(
    new Map<string, 'uploading' | 'cancelling' | 'action'>(),
  );
  const [progress, setProgress] = useState(new Map<string, number>());
  const [fileSlot, setFileSlot] = useState<TrainerVideoSlotDto | null>(null);
  const [preview, setPreview] = useState<{ title: string; url: string } | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const controllersRef = useRef(new Map<string, AbortController>());
  const initialOnlineRef = useRef(online);
  const programPollingRef = useRef<TrainerVideoProgramPollingController | null>(null);
  const previewControllerRef = useRef<AbortController | null>(null);

  const handleError = useCallback(
    (caught: unknown): void => {
      if (caught instanceof DOMException && caught.name === 'AbortError') return;
      if (caught instanceof ApiRequestError && caught.kind === 'auth') {
        onSessionExpired();
        return;
      }
      setError(caught instanceof Error ? caught.message : 'Не удалось выполнить действие.');
    },
    [onSessionExpired],
  );

  const load = useCallback((): void => programPollingRef.current?.refresh(), []);

  useEffect(() => {
    const uploadControllers = controllersRef.current;
    const polling = createTrainerVideoProgramPollingController(
      {
        getProgram: async (signal) =>
          validateTrainerVideoProgram(await getTrainerVideoProgram(signal)),
        getUpload: (uploadId, signal) => getTrainerVideoUpload(uploadId, signal),
        isUploadActive: (videoId) => uploadControllers.has(videoId),
        now: Date.now,
        setTimer: window.setTimeout,
        clearTimer: window.clearTimeout,
      },
      {
        onProgram: (next) => {
          setProgram(next);
          setError(null);
        },
        onError: (caught) => {
          if (caught instanceof DOMException && caught.name === 'AbortError') return false;
          handleError(caught);
          return !(caught instanceof ApiRequestError && caught.kind === 'auth');
        },
        onDeadline: () =>
          setError('Проверка видео занимает больше времени. Статус сохранён на сервере.'),
      },
      initialOnlineRef.current,
    );
    programPollingRef.current = polling;
    polling.start();
    return () => {
      if (programPollingRef.current === polling) programPollingRef.current = null;
      polling.dispose();
      previewControllerRef.current?.abort();
      uploadControllers.forEach((active) => active.abort());
      uploadControllers.clear();
    };
  }, [handleError]);

  useEffect(() => programPollingRef.current?.setOnline(online), [online]);

  const selectFile = (slot: TrainerVideoSlotDto): void => {
    if (!online) return;
    if (
      slot.slot_state === 'available' &&
      !window.confirm(
        'Старое видео останется доступным до успешной проверки новой версии. Продолжить?',
      )
    )
      return;
    setFileSlot(slot);
    window.setTimeout(() => fileInputRef.current?.click(), 0);
  };

  const onFile = (event: ChangeEvent<HTMLInputElement>): void => {
    const file = event.currentTarget.files?.[0];
    event.currentTarget.value = '';
    const slot = fileSlot;
    setFileSlot(null);
    if (file === undefined || slot === null) return;
    const controller = new AbortController();
    controllersRef.current.get(slot.video_id)?.abort();
    controllersRef.current.set(slot.video_id, controller);
    setSlotOperations((current) => new Map(current).set(slot.video_id, 'uploading'));
    setError(null);
    void uploadWorkoutVideo({
      file,
      weekNumber: selectedWeek,
      dayOfWeek: slot.day_of_week,
      existingUpload: slot.live_upload?.status === 'uploading' ? slot.live_upload : null,
      signal: controller.signal,
      onProgress: (bytes, total) =>
        setProgress((current) =>
          new Map(current).set(slot.video_id, Math.min(100, Math.round((bytes / total) * 100))),
        ),
      onState: () => load(),
    })
      .then(() => load())
      .catch(handleError)
      .finally(() => {
        if (controllersRef.current.get(slot.video_id) === controller) {
          controllersRef.current.delete(slot.video_id);
          load();
        }
        setSlotOperations((current) => {
          if (current.get(slot.video_id) !== 'uploading') return current;
          const next = new Map(current);
          next.delete(slot.video_id);
          return next;
        });
      });
  };

  const cancel = (slot: TrainerVideoSlotDto): void => {
    const upload =
      slot.live_upload ??
      (slot.latest_upload?.status === 'verification_quarantined' ? slot.latest_upload : null);
    if (upload === null) return;
    controllersRef.current.get(slot.video_id)?.abort();
    setSlotOperations((current) => new Map(current).set(slot.video_id, 'cancelling'));
    void cancelTrainerVideoUpload(upload.id)
      .then(() => load())
      .catch(handleError)
      .finally(() =>
        setSlotOperations((current) => {
          if (current.get(slot.video_id) !== 'cancelling') return current;
          const next = new Map(current);
          next.delete(slot.video_id);
          return next;
        }),
      );
  };

  const hide = (slot: TrainerVideoSlotDto): void => {
    if (!window.confirm(`Скрыть видео: неделя ${selectedWeek}, ${slot.day_label}?`)) return;
    setSlotOperations((current) => new Map(current).set(slot.video_id, 'action'));
    void unpublishTrainerVideo(selectedWeek, slot.day_of_week)
      .then(() => load())
      .catch(handleError)
      .finally(() =>
        setSlotOperations((current) => {
          const next = new Map(current);
          next.delete(slot.video_id);
          return next;
        }),
      );
  };

  const openPreview = (slot: TrainerVideoSlotDto): void => {
    previewControllerRef.current?.abort();
    const controller = new AbortController();
    previewControllerRef.current = controller;
    setSlotOperations((current) => new Map(current).set(slot.video_id, 'action'));
    void getTrainerVideoPreview(slot.video_id, controller.signal)
      .then(({ url }) => {
        if (previewControllerRef.current === controller) setPreview({ title: slot.title, url });
      })
      .catch(handleError)
      .finally(() => {
        if (previewControllerRef.current === controller) previewControllerRef.current = null;
        setSlotOperations((current) => {
          const next = new Map(current);
          next.delete(slot.video_id);
          return next;
        });
      });
  };

  if (program === null)
    return (
      <main className="trainer-video-screen">
        <p role="status">Загружаем программу видео…</p>
        {error === null ? null : (
          <div role="alert">
            <p>{error}</p>
            <button type="button" onClick={() => load()}>
              Повторить
            </button>
          </div>
        )}
      </main>
    );
  const week =
    program.weeks.find((candidate) => candidate.week_number === selectedWeek) ?? program.weeks[0]!;
  return (
    <main className="trainer-video-screen" data-testid="trainer-video-screen">
      <header className="trainer-video-heading">
        <div>
          <p>ТРЕНЕР KINETRA</p>
          <h1>Видео тренировок</h1>
        </div>
        <div className="trainer-video-summary" aria-label="Сводка видео">
          <span>Готово {program.summary.available} из 84</span>
          <span>В обработке {program.summary.processing}</span>
          <span>Ошибки {program.summary.failed}</span>
        </div>
      </header>
      {error === null ? null : (
        <div className="trainer-video-alert" role="alert">
          <p>{error}</p>
          <button type="button" onClick={() => setError(null)}>
            Закрыть
          </button>
        </div>
      )}
      {!online ? (
        <p className="trainer-video-offline" role="status">
          Нет сети. Изменения временно недоступны.
        </p>
      ) : null}
      <nav className="trainer-week-nav" aria-label="Недели программы">
        {program.weeks.map((candidate) => (
          <button
            key={candidate.week_number}
            type="button"
            aria-pressed={candidate.week_number === selectedWeek}
            aria-label={`Неделя ${candidate.week_number}, готово ${candidate.days.filter((day) => day.media.available).length} из 7`}
            onClick={() => setSelectedWeek(candidate.week_number)}
          >
            <strong>{candidate.week_number}</strong>
            <span>{candidate.days.filter((day) => day.media.available).length}/7</span>
          </button>
        ))}
      </nav>
      <section className="trainer-video-week" aria-labelledby="trainer-video-week-title">
        <h2 id="trainer-video-week-title">{week.title}</h2>
        <ol>
          {week.days.map((slot) => {
            const operation = slotOperations.get(slot.video_id);
            const busy = operation !== undefined;
            const percent =
              progress.get(slot.video_id) ??
              (slot.live_upload === null
                ? 0
                : Math.round(
                    (slot.live_upload.uploaded_bytes / slot.live_upload.expected_size_bytes) * 100,
                  ));
            return (
              <li key={slot.video_id} className={`trainer-video-slot is-${slot.slot_state}`}>
                <div className="trainer-video-slot-copy">
                  <strong>
                    {slot.day_label} · {slot.title}
                  </strong>
                  <span>
                    {slot.direction.replace('_', ' ')} · {slot.duration_minutes} мин
                  </span>
                  <small>{videoStatusText(slot)}</small>
                  {slot.latest_upload?.failure_code !== null &&
                  slot.latest_upload?.failure_code !== undefined &&
                  slot.media.available ? (
                    <em>{videoFailureText(slot.latest_upload.failure_code)}</em>
                  ) : null}
                </div>
                {slot.live_upload === null ? null : (
                  <div
                    className="trainer-video-progress"
                    data-testid={`trainer-video-progress-${selectedWeek}-${slot.day_of_week}`}
                    role="progressbar"
                    aria-label={`Загрузка: неделя ${selectedWeek}, ${slot.day_label}`}
                    aria-valuemin={0}
                    aria-valuemax={100}
                    aria-valuenow={percent}
                    aria-valuetext={`${percent}%`}
                  >
                    <span style={{ width: `${percent}%` }} />
                  </div>
                )}
                <div className="trainer-video-actions">
                  {['empty', 'failed', 'hidden'].includes(slot.slot_state) ? (
                    <button
                      data-testid={`trainer-video-upload-${selectedWeek}-${slot.day_of_week}`}
                      type="button"
                      aria-label={`${
                        slot.slot_state === 'failed'
                          ? 'Загрузить видео снова'
                          : slot.slot_state === 'hidden'
                            ? 'Загрузить новую версию видео'
                            : 'Загрузить видео'
                      }: неделя ${selectedWeek}, ${slot.day_label}`}
                      disabled={!online || busy}
                      onClick={() => selectFile(slot)}
                    >
                      {slot.slot_state === 'failed'
                        ? 'Загрузить снова'
                        : slot.slot_state === 'hidden'
                          ? 'Новая версия'
                          : 'Загрузить'}
                    </button>
                  ) : null}
                  {slot.slot_state === 'available' ? (
                    <>
                      <button
                        data-testid={`trainer-video-preview-${selectedWeek}-${slot.day_of_week}`}
                        type="button"
                        aria-label={`Посмотреть видео: неделя ${selectedWeek}, ${slot.day_label}`}
                        disabled={busy}
                        onClick={() => openPreview(slot)}
                      >
                        Посмотреть
                      </button>
                      <button
                        data-testid={`trainer-video-replace-${selectedWeek}-${slot.day_of_week}`}
                        type="button"
                        aria-label={`Заменить видео: неделя ${selectedWeek}, ${slot.day_label}`}
                        disabled={!online || busy}
                        onClick={() => selectFile(slot)}
                      >
                        Заменить
                      </button>
                      <button
                        data-testid={`trainer-video-hide-${selectedWeek}-${slot.day_of_week}`}
                        type="button"
                        aria-label={`Скрыть видео: неделя ${selectedWeek}, ${slot.day_label}`}
                        disabled={!online || busy}
                        onClick={() => hide(slot)}
                      >
                        Скрыть
                      </button>
                    </>
                  ) : null}
                  {slot.slot_state === 'hidden' ? (
                    <button
                      data-testid={`trainer-video-preview-${selectedWeek}-${slot.day_of_week}`}
                      type="button"
                      aria-label={`Посмотреть скрытое видео: неделя ${selectedWeek}, ${slot.day_label}`}
                      disabled={busy}
                      onClick={() => openPreview(slot)}
                    >
                      Посмотреть
                    </button>
                  ) : null}
                  {slot.live_upload?.status === 'uploading' ? (
                    <button
                      data-testid={`trainer-video-resume-${selectedWeek}-${slot.day_of_week}`}
                      type="button"
                      aria-label={`Продолжить загрузку видео: неделя ${selectedWeek}, ${slot.day_label}`}
                      disabled={!online || busy}
                      onClick={() => selectFile(slot)}
                    >
                      Продолжить
                    </button>
                  ) : null}
                  {slot.live_upload === null &&
                  slot.latest_upload?.status !== 'verification_quarantined' ? null : (
                    <button
                      data-testid={`trainer-video-cancel-${selectedWeek}-${slot.day_of_week}`}
                      type="button"
                      aria-label={`Отменить загрузку видео: неделя ${selectedWeek}, ${slot.day_label}`}
                      disabled={!online || operation === 'cancelling' || operation === 'action'}
                      onClick={() => cancel(slot)}
                    >
                      Отменить
                    </button>
                  )}
                </div>
              </li>
            );
          })}
        </ol>
      </section>
      <input
        ref={fileInputRef}
        data-testid="trainer-video-file-input"
        className="visually-hidden"
        type="file"
        accept="video/mp4,.mp4"
        aria-label="Выбрать MP4-видео"
        onChange={onFile}
      />
      {preview === null ? null : (
        <dialog
          className="trainer-video-preview"
          open
          aria-labelledby="trainer-video-preview-title"
        >
          <div>
            <h2 id="trainer-video-preview-title">{preview.title}</h2>
            <button type="button" autoFocus onClick={() => setPreview(null)}>
              Закрыть
            </button>
          </div>
          <video controls autoPlay={false} src={preview.url} />
        </dialog>
      )}
      <span className="visually-hidden" aria-live="polite">
        {slotOperations.size === 0 ? '' : 'Состояние загрузки обновлено'}
      </span>
    </main>
  );
};
