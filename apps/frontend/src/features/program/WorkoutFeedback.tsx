import React from 'react';
import { useRef, useState } from 'react';
import { saveWorkoutSession } from '../../lib/api';

export const WorkoutFeedback = ({
  videoId,
  week,
  initialDifficulty,
  initialWellbeing,
  initialNote,
}: {
  readonly videoId: string;
  readonly week: number;
  readonly initialDifficulty: number | null;
  readonly initialWellbeing: number | null;
  readonly initialNote: string;
}): React.ReactNode => {
  const [difficulty, setDifficulty] = useState(initialDifficulty ?? 3);
  const [wellbeing, setWellbeing] = useState(initialWellbeing ?? 3);
  const [note, setNote] = useState(initialNote);
  const [state, setState] = useState<'idle' | 'saving' | 'saved' | 'failed'>(
    initialDifficulty === null ? 'idle' : 'saved',
  );
  const gate = useRef(false);
  const save = async (): Promise<void> => {
    if (gate.current) return;
    gate.current = true;
    setState('saving');
    try {
      await saveWorkoutSession(videoId, week, { difficulty, wellbeing, note });
      setState('saved');
    } catch {
      setState('failed');
    } finally {
      gate.current = false;
    }
  };
  return (
    <section className="workout-feedback" aria-labelledby="workout-feedback-heading">
      <p className="program-kicker">ПАРА СЛОВ О ЗАНЯТИИ</p>
      <h2 id="workout-feedback-heading">Как прошло?</h2>
      <p>Ваши отметки увидит назначенный тренер.</p>
      <form
        onSubmit={(event) => {
          event.preventDefault();
          void save();
        }}
      >
        <label>
          Сложность
          <select
            value={difficulty}
            disabled={state === 'saving'}
            onChange={(event) => {
              setDifficulty(Number(event.target.value));
              setState('idle');
            }}
          >
            <option value={1}>1 — очень легко</option>
            <option value={2}>2 — легко</option>
            <option value={3}>3 — умеренно</option>
            <option value={4}>4 — сложно</option>
            <option value={5}>5 — очень сложно</option>
          </select>
        </label>
        <label>
          Самочувствие после
          <select
            value={wellbeing}
            disabled={state === 'saving'}
            onChange={(event) => {
              setWellbeing(Number(event.target.value));
              setState('idle');
            }}
          >
            <option value={1}>1 — плохое</option>
            <option value={2}>2 — ниже обычного</option>
            <option value={3}>3 — обычное</option>
            <option value={4}>4 — хорошее</option>
            <option value={5}>5 — отличное</option>
          </select>
        </label>
        <label>
          Комментарий для тренера
          <textarea
            value={note}
            maxLength={1000}
            disabled={state === 'saving'}
            placeholder="Что получилось, а с чем нужна помощь?"
            onChange={(event) => {
              setNote(event.target.value);
              setState('idle');
            }}
          />
        </label>
        <button
          className="primary-button"
          type="submit"
          disabled={state === 'saving' || state === 'saved'}
        >
          {state === 'saving'
            ? 'Сохраняем…'
            : state === 'saved'
              ? 'Отметки сохранены'
              : 'Сохранить отметки'}
        </button>
        {state === 'failed' && <p role="alert">Отметки не сохранились. Повторите отправку.</p>}
        {state === 'saved' && <p role="status">Спасибо. Можно вернуться к своему дню.</p>}
      </form>
    </section>
  );
};
