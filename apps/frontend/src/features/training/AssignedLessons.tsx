import { useRef, useState } from 'react';
import type { AssignedTrainingLesson } from '@kinetra/shared';
import { TrainingPlayer } from './TrainingPlayer';
import { trainingApi, trainingMessage } from './api';
export const AssignedLessons = ({
  lessons,
  readOnly = false,
  onSaved,
}: {
  lessons: AssignedTrainingLesson[];
  readOnly?: boolean;
  onSaved?: () => void;
}) => {
  const [selected, setSelected] = useState<string | null>(null),
    [error, setError] = useState(''),
    [busy, setBusy] = useState(false);
  const completed = useRef(new Set<string>());
  const save = async (id: string, input: { position_seconds?: number; completed?: true }) => {
    try {
      await trainingApi.lessonProgress(id, input);
      setError('');
      if (input.completed) {
        completed.current.add(id);
        onSaved?.();
      }
    } catch (e) {
      setError(trainingMessage(e));
    }
  };
  if (!lessons.length) return null;
  return (
    <section className="assigned-lessons" aria-label="Уроки от тренера">
      <h2>Уроки от тренера</h2>
      <p className="training-muted">Отдельные уроки в дополнение к программе.</p>
      {lessons.map((l) => (
        <article className="training-card" key={l.id}>
          <span className="training-badge">
            {l.audience === 'personal' ? 'Персональный урок' : 'Общий урок'}
          </span>
          <h3>{l.title}</h3>
          {l.description && <p className="training-instructions">{l.description}</p>}
          <p>
            {l.completed_at || completed.current.has(l.id)
              ? '✓ Урок пройден'
              : l.position_seconds > 0
                ? `Просмотрено ${Math.floor(l.position_seconds / 60)}:${String(l.position_seconds % 60).padStart(2, '0')}`
                : 'Ещё не начал'}
          </p>
          {!readOnly && (
            <>
              <div className="training-actions">
                <button type="button" onClick={() => setSelected(selected === l.id ? null : l.id)}>
                  {selected === l.id ? 'Закрыть урок' : 'Смотреть урок'}
                </button>
                {!l.completed_at && !completed.current.has(l.id) && (
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() => {
                      setBusy(true);
                      void save(l.id, { completed: true }).finally(() => setBusy(false));
                    }}
                  >
                    Отметить пройденным
                  </button>
                )}
              </div>
              {selected === l.id && (
                <TrainingPlayer
                  key={l.id}
                  id={l.id}
                  title={l.title}
                  position={l.position_seconds}
                  onPosition={(seconds) => {
                    void save(l.id, { position_seconds: seconds });
                  }}
                />
              )}
            </>
          )}
        </article>
      ))}
      {error && (
        <p role="alert" className="training-error">
          {error} Результат пока не сохранён — повторите действие после восстановления связи.
        </p>
      )}
    </section>
  );
};
