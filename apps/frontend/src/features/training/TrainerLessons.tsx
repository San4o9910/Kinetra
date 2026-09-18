import React, { useEffect, useRef, useState } from 'react';
import type { TrainingLibrary } from '@kinetra/shared';
import { trainingApi, trainingMessage } from './api';
import { TrainingPlayer } from './TrainingPlayer';
export const TrainerLessons = (): React.ReactNode => {
  const [data, setData] = useState<TrainingLibrary | null>(null);
  const [revision, setRevision] = useState(0);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [stage, setStage] = useState('');
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [file, setFile] = useState<File | null>(null);
  const [preview, setPreview] = useState<string | null>(null);
  const controller = useRef<AbortController | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  useEffect(() => {
    const c = new AbortController();
    void trainingApi
      .library(c.signal)
      .then(setData)
      .catch((e) => {
        if (!c.signal.aborted) setError(trainingMessage(e));
      });
    return () => c.abort();
  }, [revision]);
  useEffect(() => () => controller.current?.abort(), []);
  const upload = async () => {
    if (!file || busy) return;
    setBusy(true);
    setError('');
    controller.current = new AbortController();
    setStage('Загружаем и проверяем видео. Не закрывайте страницу.');
    try {
      const lesson = await trainingApi.createLesson(title, description, file.size);
      await trainingApi.upload(lesson.id, file, controller.current.signal);
      setTitle('');
      setDescription('');
      setFile(null);
      if (fileInput.current) fileInput.current.value = '';
      setStage('Урок готов. Теперь его можно добавить в программу ученика.');
    } catch (e) {
      setError(trainingMessage(e));
      setStage('');
    } finally {
      setBusy(false);
      setRevision((v) => v + 1);
    }
  };
  return (
    <main className="training-workspace">
      <div className="training-heading">
        <div>
          <p className="survey-kicker">БИБЛИОТЕКА ТРЕНЕРА</p>
          <h1>Мои видеоуроки</h1>
          <p>Загрузите урок один раз и добавляйте его в программы своих учеников.</p>
        </div>
      </div>
      {error && (
        <p className="training-error" role="alert">
          {error}{' '}
          <button
            type="button"
            onClick={() => {
              setError('');
              setRevision((v) => v + 1);
            }}
          >
            Обновить
          </button>
        </p>
      )}
      <form
        className="training-card training-form"
        onSubmit={(e) => {
          e.preventDefault();
          void upload();
        }}
      >
        <h2>Новый урок</h2>
        <label>
          Название
          <input
            required
            maxLength={160}
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            disabled={busy}
          />
        </label>
        <label>
          Описание и техника выполнения
          <textarea
            maxLength={5000}
            rows={3}
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            disabled={busy}
          />
        </label>
        <label>
          Видео с устройства
          <input
            ref={fileInput}
            type="file"
            accept="video/mp4,.mp4"
            required
            disabled={busy || data?.upload_available !== true}
            onChange={(e) => {
              const f = e.target.files?.[0] ?? null;
              if (f && f.size > 256 * 1024 * 1024) {
                setError('Выберите видео размером до 256 МБ.');
                e.target.value = '';
                setFile(null);
              } else setFile(f);
            }}
          />
        </label>
        <p className="training-muted">
          MP4 (H.264), до 256 МБ и 2 часов. Видео увидят только ученики, которым вы назначите урок.
        </p>
        {data && !data.upload_available && (
          <p role="status">
            Загрузка временно недоступна. Сохранённые уроки остаются в библиотеке.
          </p>
        )}
        <button
          className="primary-button"
          disabled={busy || !file || !title.trim() || data?.upload_available !== true}
        >
          {busy ? 'Загружаем…' : 'Загрузить урок'}
        </button>
        {busy && (
          <button type="button" onClick={() => controller.current?.abort()}>
            Отменить загрузку
          </button>
        )}
        {stage && <p role="status">{stage}</p>}
      </form>
      {!data && !error && <p role="status">Загружаем библиотеку…</p>}
      <div className="training-lesson-grid">
        {data?.lessons.map((lesson) => (
          <article className="training-card" key={lesson.id}>
            <span className="training-badge">
              {lesson.status === 'ready'
                ? 'Готов к занятиям'
                : lesson.status === 'failed'
                  ? 'Загрузка не завершена'
                  : 'Ожидает загрузки'}
            </span>
            <h2>{lesson.title}</h2>
            <p>{lesson.description}</p>
            <p className="training-muted">
              {(lesson.size_bytes / 1024 / 1024).toFixed(1)} МБ{' '}
              {lesson.duration_seconds ? `· ${Math.ceil(lesson.duration_seconds / 60)} мин` : ''}
            </p>
            <div className="training-actions">
              {lesson.status === 'ready' && (
                <button
                  type="button"
                  onClick={() => setPreview(preview === lesson.id ? null : lesson.id)}
                >
                  {preview === lesson.id ? 'Закрыть видео' : 'Посмотреть'}
                </button>
              )}
              <button
                type="button"
                disabled={busy || lesson.status === 'uploading'}
                onClick={() => {
                  if (!window.confirm(`Удалить урок «${lesson.title}»?`)) return;
                  setBusy(true);
                  void trainingApi
                    .removeLesson(lesson.id)
                    .then(() => {
                      setPreview(null);
                      setRevision((v) => v + 1);
                    })
                    .catch((e) => setError(trainingMessage(e)))
                    .finally(() => setBusy(false));
                }}
              >
                Удалить
              </button>
            </div>
            {preview === lesson.id && <TrainingPlayer id={lesson.id} title={lesson.title} />}
          </article>
        ))}
      </div>
      {data?.lessons.length === 0 && (
        <p className="training-empty">Пока нет уроков. Загрузите первое видео выше.</p>
      )}
    </main>
  );
};
