import { useEffect, useState } from 'react';
import type { TrainingMeasurement, TrainingPlan } from '@kinetra/shared';
import { trainingApi, trainingMessage } from './api';
import { apiBaseUrl } from '../../lib/api';
export const ExerciseProgress = ({ plans }: { plans: TrainingPlan[] }) => {
  const history = plans
    .flatMap((p) => p.workouts)
    .filter((w) => w.completed_at)
    .flatMap((w) =>
      (w.set_records ?? [])
        .filter((r) => r.completed)
        .map((r) => ({
          date: w.completed_at!,
          name: w.exercises?.find((e) => e.id === r.exercise_id)?.name ?? 'Упражнение',
          ...r,
        })),
    )
    .sort((a, b) => a.date.localeCompare(b.date));
  const names = [...new Set(history.map((r) => r.name))];
  const [choice, setChoice] = useState('');
  const selected = choice || names[0] || '';
  const records = history.filter((r) => r.name === selected);
  return (
    <section className="training-card">
      <h2>Результаты упражнений</h2>
      {names.length === 0 ? (
        <p className="training-muted">
          После выполненных тренировок здесь появятся фактические веса, повторения и время каждого
          подхода.
        </p>
      ) : (
        <>
          <label>
            Упражнение
            <select value={selected} onChange={(e) => setChoice(e.target.value)}>
              {names.map((name) => (
                <option key={name}>{name}</option>
              ))}
            </select>
          </label>
          <div className="training-table-wrap">
            <table>
              <caption>История: {selected}</caption>
              <thead>
                <tr>
                  <th>Дата</th>
                  <th>Подход</th>
                  <th>Вес</th>
                  <th>Результат</th>
                </tr>
              </thead>
              <tbody>
                {records
                  .slice(-60)
                  .reverse()
                  .map((r, i) => (
                    <tr key={`${r.date}:${r.set}:${i}`}>
                      <td>{new Date(r.date).toLocaleDateString('ru-RU')}</td>
                      <td>{r.set}</td>
                      <td>{r.weight_kg !== null ? `${r.weight_kg} кг` : '—'}</td>
                      <td>
                        {r.repetitions !== null
                          ? `${r.repetitions} повт.`
                          : `${r.seconds ?? 0} сек`}
                      </td>
                    </tr>
                  ))}
              </tbody>
            </table>
          </div>
        </>
      )}
    </section>
  );
};
const today = () => new Date().toLocaleDateString('en-CA');
export const Measurements = ({ studentId }: { studentId?: string }) => {
  const [records, setRecords] = useState<TrainingMeasurement[]>([]),
    [revision, setRevision] = useState(0),
    [error, setError] = useState(''),
    [busy, setBusy] = useState(false),
    [photos, setPhotos] = useState<Record<string, string>>({}),
    [file, setFile] = useState<File | null>(null),
    [open, setOpen] = useState(false);
  const empty = (): Omit<TrainingMeasurement, 'id' | 'photo_id'> => ({
    recorded_date: today(),
    weight_kg: null,
    waist_cm: null,
    chest_cm: null,
    hips_cm: null,
    note: '',
    share_with_trainer: false,
  });
  const [form, setForm] = useState(empty);
  useEffect(() => {
    let active = true;
    void trainingApi
      .measurements(studentId)
      .then((v) => {
        if (active) setRecords(v.measurements);
      })
      .catch((e) => {
        if (active) setError(trainingMessage(e));
      });
    return () => {
      active = false;
    };
  }, [studentId, revision]);
  const run = async (fn: () => Promise<unknown>) => {
    setBusy(true);
    setError('');
    try {
      await fn();
      setRevision((v) => v + 1);
    } catch (e) {
      setError(trainingMessage(e));
    } finally {
      setBusy(false);
    }
  };
  const weights = records
    .filter((r) => r.weight_kg !== null)
    .slice(0, 20)
    .reverse();
  const min = Math.min(...weights.map((r) => r.weight_kg!)),
    max = Math.max(...weights.map((r) => r.weight_kg!));
  return (
    <section className="training-card training-measurements">
      <div className="training-heading">
        <h2>{studentId ? 'Замеры ученика' : 'Замеры и фотографии'}</h2>
        {!studentId && (
          <button type="button" onClick={() => setOpen((v) => !v)}>
            ＋ Добавить замер
          </button>
        )}
      </div>
      {studentId && (
        <p className="training-muted">Видны только записи, которыми ученик поделился с вами.</p>
      )}
      {open && !studentId && (
        <form
          className="training-form"
          onSubmit={(e) => {
            e.preventDefault();
            void run(async () => {
              const added = await trainingApi.addMeasurement(form);
              if (file) {
                try {
                  await trainingApi.uploadPhoto(added.id, file);
                } catch (e) {
                  setOpen(false);
                  setForm(empty());
                  setFile(null);
                  setRevision((v) => v + 1);
                  throw new Error(`Замеры сохранены, фото не загрузилось. ${trainingMessage(e)}`);
                }
              }
              setForm(empty());
              setFile(null);
              setOpen(false);
            });
          }}
        >
          <fieldset disabled={busy}>
            <label>
              Дата
              <input
                type="date"
                required
                value={form.recorded_date}
                onChange={(e) => setForm((v) => ({ ...v, recorded_date: e.target.value }))}
              />
            </label>
            <div className="training-fields">
              {(
                [
                  ['weight_kg', 'Вес, кг', 20, 400],
                  ['waist_cm', 'Талия, см', 20, 300],
                  ['chest_cm', 'Грудь, см', 20, 300],
                  ['hips_cm', 'Бёдра, см', 20, 300],
                ] as const
              ).map(([key, label, min, max]) => (
                <label key={key}>
                  {label}
                  <input
                    type="number"
                    step="0.1"
                    min={min}
                    max={max}
                    value={form[key] ?? ''}
                    onChange={(e) =>
                      setForm((v) => ({
                        ...v,
                        [key]: e.target.value === '' ? null : Number(e.target.value),
                      }))
                    }
                  />
                </label>
              ))}
            </div>
            <label>
              Комментарий
              <textarea
                maxLength={1000}
                value={form.note}
                onChange={(e) => setForm((v) => ({ ...v, note: e.target.value }))}
              />
            </label>
            <label>
              Фото · по желанию
              <input
                type="file"
                accept="image/jpeg,image/png,image/webp"
                onChange={(e) => {
                  const f = e.target.files?.[0] ?? null;
                  if (f && f.size > 10 * 1024 ** 2) {
                    setError('Выберите фото до 10 МБ.');
                    e.target.value = '';
                    return;
                  }
                  setFile(f);
                }}
              />
            </label>
            <label className="training-check">
              <input
                type="checkbox"
                checked={form.share_with_trainer}
                onChange={(e) => setForm((v) => ({ ...v, share_with_trainer: e.target.checked }))}
              />
              Показывать эту запись и фото моему тренеру
            </label>
            <p className="training-muted">
              Без этой отметки запись видна только вам. Доступ можно отключить позже.
            </p>
            <button className="primary-button">{busy ? 'Сохраняем…' : 'Сохранить замер'}</button>
          </fieldset>
        </form>
      )}
      {weights.length > 1 && (
        <figure className="training-weight-chart">
          <svg
            viewBox="0 0 360 120"
            role="img"
            aria-label={`Изменение веса: от ${weights[0]!.weight_kg} до ${weights.at(-1)!.weight_kg} кг`}
          >
            <polyline
              fill="none"
              stroke="currentColor"
              strokeWidth="3"
              points={weights
                .map(
                  (r, i) =>
                    `${10 + (i * 340) / (weights.length - 1)},${100 - ((r.weight_kg! - min) / Math.max(max - min, 1)) * 80}`,
                )
                .join(' ')}
            />
          </svg>
          <figcaption>
            {weights[0]!.weight_kg} → {weights.at(-1)!.weight_kg} кг · последние {weights.length}{' '}
            записей
          </figcaption>
        </figure>
      )}
      {records.map((r) => (
        <article className="training-measurement" key={r.id}>
          <div className="training-actions">
            <strong>{new Date(r.recorded_date + 'T12:00:00').toLocaleDateString('ru-RU')}</strong>
            <span className="training-badge">
              {r.share_with_trainer ? 'Доступно тренеру' : 'Только вам'}
            </span>
          </div>
          <p>
            {[
              ['Вес', r.weight_kg, 'кг'],
              ['Талия', r.waist_cm, 'см'],
              ['Грудь', r.chest_cm, 'см'],
              ['Бёдра', r.hips_cm, 'см'],
            ]
              .filter((v) => v[1] !== null)
              .map((v) => v.join(' '))
              .join(' · ')}
          </p>
          {r.note && <p>{r.note}</p>}
          {r.photo_id && (
            <button
              type="button"
              onClick={() => {
                if (photos[r.id]) {
                  setPhotos((v) => ({ ...v, [r.id]: '' }));
                  return;
                }
                void trainingApi
                  .photoAccess(r.id)
                  .then((v) => setPhotos((old) => ({ ...old, [r.id]: v.path })))
                  .catch((e) => setError(trainingMessage(e)));
              }}
            >
              {photos[r.id] ? 'Скрыть фото' : 'Посмотреть фото'}
            </button>
          )}
          {photos[r.id] && (
            <img
              className="training-progress-photo"
              src={apiBaseUrl + photos[r.id]}
              alt={`Фото прогресса от ${r.recorded_date}`}
              referrerPolicy="no-referrer"
            />
          )}
          {!studentId && (
            <div className="training-actions">
              <button
                type="button"
                disabled={busy}
                onClick={() =>
                  void run(() => trainingApi.shareMeasurement(r.id, !r.share_with_trainer))
                }
              >
                {r.share_with_trainer ? 'Закрыть доступ тренеру' : 'Поделиться с тренером'}
              </button>
              <button
                type="button"
                disabled={busy}
                onClick={() => {
                  if (window.confirm('Удалить эту запись и фото?'))
                    void run(() => trainingApi.removeMeasurement(r.id));
                }}
              >
                Удалить
              </button>
            </div>
          )}
        </article>
      ))}
      {!records.length && !error && (
        <p className="training-muted">
          Замеров пока нет. Добавляйте только те показатели, которые важны для вашей цели.
        </p>
      )}
      {error && (
        <p role="alert" className="training-error">
          {error}
        </p>
      )}
    </section>
  );
};
