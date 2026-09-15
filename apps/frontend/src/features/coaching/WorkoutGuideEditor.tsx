import React from 'react';
import { useEffect, useRef, useState } from 'react';
import { getWorkoutGuide, saveWorkoutGuide } from '../../lib/api';

export const WorkoutGuideEditor = ({
  videoId,
  title,
  onClose,
}: {
  readonly videoId: string;
  readonly title: string;
  readonly onClose: () => void;
}): React.ReactNode => {
  const [equipment, setEquipment] = useState('');
  const [technique, setTechnique] = useState('');
  const [chapters, setChapters] = useState('');
  const [state, setState] = useState<'loading' | 'ready' | 'saving' | 'saved' | 'error'>('loading');
  const [message, setMessage] = useState<string | null>(null);
  const gate = useRef(false);
  const headingRef = useRef<HTMLHeadingElement>(null);
  useEffect(() => {
    headingRef.current?.focus({ preventScroll: true });
    headingRef.current?.scrollIntoView({ block: 'start' });
    const controller = new AbortController();
    void getWorkoutGuide(videoId, controller.signal)
      .then((guide) => {
        if (controller.signal.aborted) return;
        setEquipment(guide.equipment.join(', '));
        setTechnique(guide.technique);
        setChapters(
          guide.chapters
            .map(
              (chapter) =>
                `${Math.floor(chapter.start_seconds / 60)}:${String(chapter.start_seconds % 60).padStart(2, '0')} ${chapter.title}`,
            )
            .join('\n'),
        );
        setState('ready');
      })
      .catch(() => {
        if (!controller.signal.aborted) {
          setState('error');
          setMessage('Не удалось загрузить подсказки. Закройте и откройте редактор снова.');
        }
      });
    return () => controller.abort();
  }, [videoId]);
  const save = async (): Promise<void> => {
    if (gate.current) return;
    const items = chapters
      .split('\n')
      .filter((line) => line.trim())
      .map((line) => /^\s*(\d{1,3}):([0-5]\d)\s+(.+?)\s*$/u.exec(line));
    if (items.some((item) => item === null)) {
      setMessage('Каждая строка: минута:секунда название. Например, 0:00 Начало.');
      return;
    }
    gate.current = true;
    setState('saving');
    setMessage(null);
    try {
      await saveWorkoutGuide(videoId, {
        equipment: equipment
          .split(',')
          .map((item) => item.trim())
          .filter(Boolean),
        technique,
        chapters: items.map((item) => ({
          start_seconds: Number(item![1]) * 60 + Number(item![2]),
          title: item![3]!,
        })),
      });
      setState('saved');
      setMessage('Подсказки сохранены и доступны в тренировке.');
    } catch {
      setState('ready');
      setMessage('Не удалось сохранить. Проверьте порядок времени и повторите.');
    } finally {
      gate.current = false;
    }
  };
  return (
    <section className="workout-guide-editor" aria-label="Редактор подсказок">
      <h2 ref={headingRef} tabIndex={-1}>
        {title}
      </h2>
      <p>Укажите реальный инвентарь, пояснения к технике и разделы видео.</p>
      <form
        onSubmit={(event) => {
          event.preventDefault();
          void save();
        }}
      >
        <fieldset disabled={state === 'loading' || state === 'saving' || state === 'error'}>
          <label>
            Инвентарь через запятую
            <input
              value={equipment}
              maxLength={2000}
              onChange={(event) => setEquipment(event.target.value)}
            />
          </label>
          <label>
            Подсказки по технике
            <textarea
              value={technique}
              maxLength={5000}
              onChange={(event) => setTechnique(event.target.value)}
            />
          </label>
          <label>
            Разделы видео — время и название
            <textarea
              value={chapters}
              maxLength={9000}
              placeholder="0:00 Введение"
              onChange={(event) => setChapters(event.target.value)}
            />
          </label>
          <button className="primary-button" type="submit">
            {state === 'saving' ? 'Сохраняем…' : 'Сохранить подсказки'}
          </button>
        </fieldset>
        <button
          type="button"
          className="secondary-button"
          disabled={state === 'saving'}
          onClick={onClose}
        >
          Закрыть редактор
        </button>
      </form>
      {message && <p role="status">{message}</p>}
    </section>
  );
};
