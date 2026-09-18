import React, { useEffect, useRef, useState } from 'react';
import { LessonSharing } from './LessonSharing';
import type { TrainingLibrary, TrainingLesson, TrainingStudent } from '@kinetra/shared';
import { trainingApi, trainingMessage } from './api';
import { TrainingPlayer } from './TrainingPlayer';
const LessonCover = ({ lesson }: { lesson: TrainingLesson }) => {
  const [url, setUrl] = useState('');
  useEffect(() => {
    if (!lesson.thumbnail_ready) return;
    let active = true;
    void trainingApi
      .access(lesson.id)
      .then((v) => {
        if (active) setUrl(v.path.replace('/media/', '/thumbnails/'));
      })
      .catch(() => {});
    return () => {
      active = false;
    };
  }, [lesson.id, lesson.thumbnail_ready]);
  return url ? (
    <img
      className="training-lesson-cover"
      src={url}
      alt=""
      loading="lazy"
      referrerPolicy="no-referrer"
    />
  ) : (
    <div className="training-lesson-cover training-cover-placeholder" aria-hidden="true">
      K<span>▶</span>
    </div>
  );
};
export const TrainerLessons = (): React.ReactNode => {
  const [audience, setAudience] = useState<'shared' | 'personal'>('shared'),
    [personalStudent, setPersonalStudent] = useState(''),
    [students, setStudents] = useState<TrainingStudent[]>([]),
    [sharing, setSharing] = useState<string | null>(null);
  useEffect(() => {
    const c = new AbortController();
    void trainingApi
      .students(c.signal)
      .then((v) => setStudents(v.students.filter((s) => !s.archived_at)))
      .catch((e) => {
        if (!c.signal.aborted) setError(trainingMessage(e));
      });
    return () => c.abort();
  }, []);
  const [data, setData] = useState<TrainingLibrary | null>(null),
    [revision, setRevision] = useState(0),
    [error, setError] = useState(''),
    [busy, setBusy] = useState(false),
    [stage, setStage] = useState(''),
    [progress, setProgress] = useState(0),
    [title, setTitle] = useState(''),
    [description, setDescription] = useState(''),
    [folder, setFolder] = useState(''),
    [file, setFile] = useState<File | null>(null),
    [preview, setPreview] = useState<string | null>(null),
    [query, setQuery] = useState(''),
    [filter, setFilter] = useState('all'),
    [resumeId, setResumeId] = useState<string | null>(null);
  const controller = useRef<AbortController | null>(null),
    fileInput = useRef<HTMLInputElement>(null),
    resumeInput = useRef<HTMLInputElement>(null),
    active = useRef(true),
    uploading = useRef(false);
  useEffect(() => {
    active.current = true;
    return () => {
      active.current = false;
      controller.current?.abort();
    };
  }, []);
  useEffect(() => {
    const c = new AbortController();
    const load = () => {
      void trainingApi
        .library(c.signal)
        .then((v) => {
          if (!c.signal.aborted) setData(v);
        })
        .catch((e) => {
          if (!c.signal.aborted) setError(trainingMessage(e));
        });
    };
    load();
    const timer = setInterval(load, 5000);
    return () => {
      c.abort();
      clearInterval(timer);
    };
  }, [revision]);
  useEffect(() => {
    if (!busy) return;
    const before = (e: BeforeUnloadEvent) => {
      e.preventDefault();
      e.returnValue = '';
    };
    window.addEventListener('beforeunload', before);
    return () => window.removeEventListener('beforeunload', before);
  }, [busy]);
  const upload = async (selected: File, id?: string) => {
    if (uploading.current) return;
    uploading.current = true;
    setBusy(true);
    setError('');
    setProgress(0);
    const c = new AbortController();
    controller.current = c;
    try {
      const lessonId =
        id ??
        (
          await trainingApi.createLesson(title, description, selected.size, {
            folder,
            audience,
            personal_student_id: audience === 'personal' ? personalStudent : null,
            original_name: selected.name.slice(0, 200),
            source_modified: selected.lastModified,
          })
        ).id;
      let state = await trainingApi.uploadStatus(lessonId);
      if (
        state.size !== selected.size ||
        state.original_name !== selected.name.slice(0, 200) ||
        (state.source_modified !== null && state.source_modified !== selected.lastModified)
      )
        throw new Error('Выберите тот же файл, с которого началась загрузка.');
      let offset = state.offset;
      setProgress(Math.floor((offset / selected.size) * 100));
      setStage('Загружаем видео. При обрыве связи можно продолжить с сохранённого места.');
      while (offset < selected.size) {
        if (c.signal.aborted) throw new DOMException('Paused', 'AbortError');
        try {
          const chunk = selected.slice(offset, Math.min(offset + state.chunk_bytes, selected.size));
          offset = (await trainingApi.uploadChunk(lessonId, chunk, offset, c.signal)).offset;
        } catch (e) {
          if (c.signal.aborted) throw e;
          state = await trainingApi.uploadStatus(lessonId);
          if (state.offset <= offset) throw e;
          offset = state.offset;
        }
        if (active.current) setProgress(Math.floor((offset / selected.size) * 100));
      }
      await trainingApi.finishUpload(lessonId);
      if (active.current) {
        setStage('Видео загружено. Подготавливаем его для учеников — страницу можно закрыть.');
        setTitle('');
        setDescription('');
        setFile(null);
        if (fileInput.current) fileInput.current.value = '';
      }
    } catch (e) {
      if (active.current) {
        if (c.signal.aborted)
          setStage('Загрузка приостановлена. Нажмите «Продолжить» у урока и выберите тот же файл.');
        else setError(trainingMessage(e));
      }
    } finally {
      uploading.current = false;
      if (active.current) {
        setBusy(false);
        setRevision((v) => v + 1);
      }
    }
  };
  const labels: Record<string, string> = {
    pending: 'Ожидает загрузки',
    uploading: 'Можно продолжить загрузку',
    processing: 'Подготавливаем видео',
    ready: 'Готов к занятиям',
    failed: 'Не удалось загрузить',
  };
  const folders = [...new Set((data?.lessons ?? []).map((l) => l.folder || 'Без папки'))];
  const visible = data?.lessons.filter(
    (l) =>
      (filter === 'all' || (l.folder || 'Без папки') === filter) &&
      `${l.title} ${l.description}`
        .toLocaleLowerCase('ru-RU')
        .includes(query.toLocaleLowerCase('ru-RU')),
  );
  return (
    <main className="training-workspace">
      <div className="training-heading">
        <div>
          <p className="survey-kicker">БИБЛИОТЕКА ТРЕНЕРА</p>
          <h1>Мои видеоуроки</h1>
          <p>
            Создавайте общие и персональные уроки. Назначайте одному ученику, нескольким или всем.
          </p>
        </div>
      </div>
      {error && (
        <p role="alert" className="training-error">
          {error}
        </p>
      )}
      <form
        className="training-card training-form"
        onSubmit={(e) => {
          e.preventDefault();
          if (file) void upload(file);
        }}
      >
        <h2>Новый урок</h2>
        <fieldset disabled={busy}>
          <label>
            Тип урока
            <select
              value={audience}
              onChange={(e) => setAudience(e.target.value as 'shared' | 'personal')}
            >
              <option value="shared">Общий — для нескольких учеников</option>
              <option value="personal">Персональный — для одного ученика</option>
            </select>
          </label>
          {audience === 'personal' ? (
            <label>
              Для кого
              <select
                required
                value={personalStudent}
                onChange={(e) => setPersonalStudent(e.target.value)}
              >
                <option value="">Выберите ученика</option>
                {students.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.name}
                    {!s.client_id ? ' · ожидает приглашения' : ''}
                  </option>
                ))}
              </select>
              <small>
                После подготовки видео ученик получит урок автоматически. Другим ученикам его
                назначить нельзя.
              </small>
            </label>
          ) : (
            <p className="training-muted">
              После подготовки видео выберите получателей в карточке урока. До назначения видео
              видно только вам.
            </p>
          )}

          <label>
            Название
            <input
              required
              maxLength={160}
              value={title}
              onChange={(e) => setTitle(e.target.value)}
            />
          </label>
          <label>
            Описание и техника выполнения
            <textarea
              maxLength={5000}
              rows={3}
              value={description}
              onChange={(e) => setDescription(e.target.value)}
            />
          </label>
          <label>
            Папка · необязательно
            <input
              list="lesson-folders"
              maxLength={80}
              value={folder}
              placeholder="Например, разминка"
              onChange={(e) => setFolder(e.target.value)}
            />
            <datalist id="lesson-folders">
              {folders
                .filter((f) => f !== 'Без папки')
                .map((f) => (
                  <option key={f} value={f} />
                ))}
            </datalist>
          </label>
          <label>
            Видео с устройства
            <input
              ref={fileInput}
              type="file"
              accept="video/mp4,video/quicktime,video/webm,.mp4,.mov,.webm"
              required
              disabled={busy || !data?.upload_available}
              onChange={(e) => {
                const f = e.target.files?.[0] ?? null;
                if (f && f.size > 256 * 1024 ** 2) {
                  setError('Выберите видео до 256 МБ.');
                  e.target.value = '';
                  setFile(null);
                } else setFile(f);
              }}
            />
          </label>
        </fieldset>
        <p className="training-muted">
          MP4, MOV или WebM, до 256 МБ и 2 часов. Формат подготовится автоматически. Видео доступны
          только вашим назначенным ученикам.
        </p>
        <button
          className="primary-button"
          disabled={
            busy ||
            !file ||
            !title.trim() ||
            !data?.upload_available ||
            (audience === 'personal' && !personalStudent)
          }
        >
          {busy ? 'Загружаем…' : 'Загрузить урок'}
        </button>
        {busy && (
          <>
            <progress max={100} value={progress} aria-label="Загрузка видео" />
            <p role="status">{progress}%</p>
            <button type="button" onClick={() => controller.current?.abort()}>
              Приостановить загрузку
            </button>
          </>
        )}
        {stage && <p role="status">{stage}</p>}
        {data && !data.upload_available && <p role="status">Загрузка временно недоступна.</p>}
      </form>
      <div className="training-library-toolbar">
        <label>
          Найти урок
          <input
            type="search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Название или описание"
          />
        </label>
        <label>
          Папка
          <select value={filter} onChange={(e) => setFilter(e.target.value)}>
            <option value="all">Все папки</option>
            {folders.map((f) => (
              <option key={f}>{f}</option>
            ))}
          </select>
        </label>
      </div>
      <input
        className="training-file-hidden"
        ref={resumeInput}
        type="file"
        accept="video/*,.mov,.mp4,.webm"
        aria-label="Исходный файл для продолжения загрузки"
        onChange={(e) => {
          const f = e.target.files?.[0];
          if (f && resumeId) void upload(f, resumeId);
          e.target.value = '';
        }}
      />
      <div className="training-lesson-grid">
        {visible?.map((l) => (
          <article className="training-card" key={l.id}>
            <LessonCover lesson={l} />
            <div className="training-actions">
              <span className="training-badge">{labels[l.status] ?? l.status}</span>
              <small>
                {l.audience === 'personal' ? 'Персональный' : 'Общий'} · {l.folder || 'Без папки'}
              </small>
            </div>
            <h2>{l.title}</h2>
            <p>{l.description}</p>
            <p className="training-muted">
              {(l.size_bytes / 1024 / 1024).toFixed(1)} МБ
              {l.duration_seconds ? ` · ${Math.ceil(l.duration_seconds / 60)} мин` : ''}
            </p>
            {l.error_message && <p role="status">{l.error_message}</p>}
            {l.status === 'uploading' && (
              <progress
                aria-label={`Загружено видео ${l.title}`}
                max={l.source_bytes ?? l.size_bytes}
                value={l.upload_offset ?? 0}
              />
            )}
            <div className="training-actions">
              {l.status === 'ready' && (
                <button
                  type="button"
                  aria-expanded={sharing === l.id}
                  onClick={() => setSharing(sharing === l.id ? null : l.id)}
                >
                  {sharing === l.id ? 'Скрыть назначения' : 'Назначить / результаты'}
                </button>
              )}
              {l.status === 'ready' && (
                <button type="button" onClick={() => setPreview(preview === l.id ? null : l.id)}>
                  {preview === l.id ? 'Закрыть видео' : 'Посмотреть'}
                </button>
              )}
              {['pending', 'uploading'].includes(l.status) && (
                <>
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() => {
                      setResumeId(l.id);
                      resumeInput.current?.click();
                    }}
                  >
                    Продолжить загрузку
                  </button>
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() => {
                      if (window.confirm('Отменить эту загрузку? Загруженная часть будет удалена.'))
                        void trainingApi
                          .cancelUpload(l.id)
                          .then(() => setRevision((v) => v + 1))
                          .catch((e) => setError(trainingMessage(e)));
                    }}
                  >
                    Отменить загрузку
                  </button>
                </>
              )}
              {!['uploading', 'processing'].includes(l.status) && (
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => {
                    if (window.confirm(`Удалить урок «${l.title}»?`))
                      void trainingApi
                        .removeLesson(l.id)
                        .then(() => setRevision((v) => v + 1))
                        .catch((e) => setError(trainingMessage(e)));
                  }}
                >
                  Удалить
                </button>
              )}
            </div>
            {sharing === l.id && <LessonSharing lesson={l} />}
            {preview === l.id && <TrainingPlayer id={l.id} title={l.title} />}
          </article>
        ))}
      </div>
      {data && visible?.length === 0 && (
        <p className="training-empty">
          {query || filter !== 'all'
            ? 'По запросу ничего не найдено.'
            : 'Пока нет уроков. Загрузите первое видео выше.'}
        </p>
      )}
    </main>
  );
};
