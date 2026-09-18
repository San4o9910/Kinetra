import { useEffect, useState } from 'react';
import type { TrainingLesson, TrainingLessonRecipient, TrainingStudent } from '@kinetra/shared';
import { trainingApi, trainingMessage } from './api';
export const LessonSharing = ({ lesson }: { lesson: TrainingLesson }) => {
  const [students, setStudents] = useState<TrainingStudent[]>([]),
    [recipients, setRecipients] = useState<TrainingLessonRecipient[]>([]),
    [selected, setSelected] = useState<string[]>([]),
    [target, setTarget] = useState<'selected' | 'all'>('selected'),
    [busy, setBusy] = useState(false),
    [loading, setLoading] = useState(true),
    [error, setError] = useState(''),
    [notice, setNotice] = useState(''),
    [revision, setRevision] = useState(0);
  useEffect(() => {
    let active = true;
    void Promise.all([trainingApi.students(), trainingApi.lessonRecipients(lesson.id)])
      .then(([roster, result]) => {
        if (!active) return;
        setStudents(
          roster.students.filter(
            (s) =>
              !s.archived_at &&
              (lesson.audience !== 'personal' || s.id === lesson.personal_student_id),
          ),
        );
        setRecipients(result.recipients);
        setLoading(false);
      })
      .catch((e) => {
        if (active) {
          setError(trainingMessage(e));
          setLoading(false);
        }
      });
    return () => {
      active = false;
    };
  }, [lesson.id, lesson.audience, lesson.personal_student_id, revision]);
  const action = async (fn: () => Promise<unknown>, message: string) => {
    setBusy(true);
    setError('');
    setNotice('');
    try {
      await fn();
      setNotice(message);
      setSelected([]);
      setRevision((v) => v + 1);
    } catch (e) {
      setError(trainingMessage(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <section
      className="lesson-sharing training-form"
      aria-label={`Назначение урока ${lesson.title}`}
    >
      <h3>{lesson.audience === 'personal' ? 'Персональный доступ' : 'Кому назначить урок'}</h3>
      {loading ? (
        <p role="status">Загружаем учеников…</p>
      ) : (
        <>
          <form
            onSubmit={(e) => {
              e.preventDefault();
              void action(
                () => trainingApi.assignLesson(lesson.id, target, selected),
                'Урок назначен. Результаты каждого ученика сохраняются отдельно.',
              );
            }}
          >
            <fieldset disabled={busy}>
              {lesson.audience !== 'personal' && (
                <label>
                  Получатели
                  <select
                    value={target}
                    onChange={(e) => setTarget(e.target.value as 'selected' | 'all')}
                  >
                    <option value="selected">Выбрать учеников</option>
                    <option value="all">Все текущие ученики</option>
                  </select>
                </label>
              )}
              {target === 'selected' ? (
                <div className="lesson-recipient-list">
                  {students.map((s) => (
                    <label key={s.id} className="lesson-recipient-choice">
                      <input
                        type="checkbox"
                        checked={selected.includes(s.id)}
                        onChange={(e) =>
                          setSelected((v) =>
                            e.target.checked ? [...v, s.id] : v.filter((id) => id !== s.id),
                          )
                        }
                      />
                      <span>
                        {s.name}
                        {!s.client_id && <small>Доступ появится после принятия приглашения</small>}
                      </span>
                    </label>
                  ))}
                </div>
              ) : (
                <p>
                  Урок получат все {students.length} учеников из текущего списка. Новых учеников
                  можно добавить позже. Результаты видны только вам и самому ученику.
                </p>
              )}
              {!students.length && <p>Сначала добавьте ученика в разделе «Ученики».</p>}
              <button
                className="primary-button"
                disabled={!students.length || (target === 'selected' && !selected.length)}
              >
                {busy ? 'Сохраняем…' : target === 'all' ? 'Назначить всем' : 'Назначить выбранным'}
              </button>
            </fieldset>
          </form>
          <h3>Назначено · {recipients.length}</h3>
          {!recipients.length && <p className="training-muted">Пока никому не назначено.</p>}
          {recipients.map((r) => (
            <div key={r.id} className="lesson-recipient-progress">
              <div>
                <strong>{r.name}</strong>
                <p>
                  {!r.client_id
                    ? 'Ожидает подключения'
                    : r.completed_at
                      ? '✓ Урок пройден'
                      : r.position_seconds > 0
                        ? `Просмотрено ${Math.floor(r.position_seconds / 60)}:${String(r.position_seconds % 60).padStart(2, '0')}`
                        : 'Ещё не начал'}
                </p>
              </div>
              <button
                type="button"
                disabled={busy}
                aria-label={`Отозвать назначение: ${r.name}`}
                onClick={() => {
                  void action(
                    () => trainingApi.revokeLesson(lesson.id, r.id),
                    'Назначение отозвано. Если урок есть в опубликованной программе, доступ через программу сохраняется.',
                  );
                }}
              >
                Отозвать
              </button>
            </div>
          ))}
          <p className="training-muted">
            Это отдельные назначения. Уроки в опубликованных программах управляются через редактор
            программы.
          </p>
        </>
      )}
      {notice && <p role="status">{notice}</p>}
      {error && (
        <p role="alert" className="training-error">
          {error}
        </p>
      )}
    </section>
  );
};
