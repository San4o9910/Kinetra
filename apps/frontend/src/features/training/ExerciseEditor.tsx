import type { TrainingExercise, TrainingLesson } from '@kinetra/shared';
const newExercise = (): TrainingExercise => ({
  id: crypto.randomUUID(),
  name: '',
  sets: 3,
  repetitions: 10,
  seconds: null,
  weight_kg: null,
  rest_seconds: 60,
  lesson_id: null,
});
export const ExerciseEditor = ({
  value,
  lessons,
  onChange,
  disabled = false,
}: {
  value: TrainingExercise[];
  lessons: TrainingLesson[];
  onChange: (v: TrainingExercise[]) => void;
  disabled?: boolean;
}) => {
  const update = (id: string, patch: Partial<TrainingExercise>) =>
    onChange(value.map((e) => (e.id === id ? { ...e, ...patch } : e)));
  const move = (index: number, delta: number) => {
    const next = [...value];
    [next[index], next[index + delta]] = [next[index + delta]!, next[index]!];
    onChange(next);
  };
  return (
    <fieldset className="exercise-builder" disabled={disabled}>
      <legend>Упражнения</legend>
      {value.map((e, index) => (
        <section className="exercise-editor" key={e.id} aria-label={`Упражнение ${index + 1}`}>
          <div className="training-actions">
            <strong>{String(index + 1).padStart(2, '0')}</strong>
            <button
              type="button"
              disabled={disabled || index === 0}
              onClick={() => move(index, -1)}
              aria-label={`Поднять упражнение ${index + 1}`}
            >
              ↑
            </button>
            <button
              type="button"
              disabled={disabled || index === value.length - 1}
              onClick={() => move(index, 1)}
              aria-label={`Опустить упражнение ${index + 1}`}
            >
              ↓
            </button>
            <button type="button" onClick={() => onChange(value.filter((x) => x.id !== e.id))}>
              Убрать упражнение
            </button>
          </div>
          <label>
            Название упражнения
            <input
              required
              maxLength={160}
              value={e.name}
              placeholder="Например, приседания"
              onChange={(v) => update(e.id, { name: v.target.value })}
            />
          </label>
          <div className="training-fields">
            <label>
              Подходы
              <input
                type="number"
                min={1}
                max={20}
                required
                value={e.sets}
                onChange={(v) => update(e.id, { sets: Number(v.target.value) })}
              />
            </label>
            <label>
              Измерять
              <select
                value={e.seconds === null ? 'reps' : 'time'}
                onChange={(v) =>
                  update(
                    e.id,
                    v.target.value === 'time'
                      ? { seconds: 30, repetitions: null }
                      : { seconds: null, repetitions: 10 },
                  )
                }
              >
                <option value="reps">Повторения</option>
                <option value="time">Время</option>
              </select>
            </label>
            <label>
              {e.seconds === null ? 'Повторений' : 'Секунд'}
              <input
                type="number"
                min={1}
                max={e.seconds === null ? 1000 : 7200}
                required
                value={e.seconds ?? e.repetitions ?? ''}
                onChange={(v) =>
                  update(
                    e.id,
                    e.seconds === null
                      ? { repetitions: Number(v.target.value) }
                      : { seconds: Number(v.target.value) },
                  )
                }
              />
            </label>
            <label>
              Вес, кг · необязательно
              <input
                type="number"
                min={0}
                max={1000}
                step="0.5"
                value={e.weight_kg ?? ''}
                onChange={(v) =>
                  update(e.id, { weight_kg: v.target.value === '' ? null : Number(v.target.value) })
                }
              />
            </label>
            <label>
              Отдых, секунд
              <input
                type="number"
                min={0}
                max={1800}
                value={e.rest_seconds}
                onChange={(v) => update(e.id, { rest_seconds: Number(v.target.value) })}
              />
            </label>
          </div>
          <label>
            Видео упражнения
            <select
              value={e.lesson_id ?? ''}
              onChange={(v) => update(e.id, { lesson_id: v.target.value || null })}
            >
              <option value="">Без отдельного видео</option>
              {lessons
                .filter((l) => l.status === 'ready')
                .map((l) => (
                  <option key={l.id} value={l.id}>
                    {l.title}
                  </option>
                ))}
            </select>
          </label>
        </section>
      ))}
      <button
        className="secondary-button"
        type="button"
        disabled={disabled || value.length >= 40}
        onClick={() => onChange([...value, newExercise()])}
      >
        ＋ Добавить упражнение
      </button>
    </fieldset>
  );
};
