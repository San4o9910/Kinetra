import React, {
  useEffect,
  useState,
  type CSSProperties,
  type FormEvent,
  type MouseEvent,
  type ReactNode,
} from 'react';
import type { SurveyGoal, WeeklyMetricsInput } from '@kinetra/shared';

import { clampMetricScore, goalOptions, normalizedNote, progressMetricConfigs } from './model';

interface DialogShellProps {
  readonly testId: string;
  readonly titleId: string;
  readonly busy: boolean;
  readonly onClose: () => void;
  readonly children: ReactNode;
}

const DialogShell = ({ testId, titleId, busy, onClose, children }: DialogShellProps): ReactNode => {
  const dialogRef = React.useRef<HTMLDialogElement>(null);

  useEffect(() => {
    const dialog = dialogRef.current;

    if (dialog === null) {
      return;
    }

    if (!dialog.open) {
      if (typeof dialog.showModal === 'function') {
        dialog.showModal();
      } else {
        dialog.setAttribute('open', '');
      }
    }

    return () => {
      if (dialog.open && typeof dialog.close === 'function') {
        dialog.close();
      }
    };
  }, []);

  const closeFromBackdrop = (event: MouseEvent<HTMLDialogElement>): void => {
    if (busy || event.target !== event.currentTarget) {
      return;
    }

    const bounds = event.currentTarget.getBoundingClientRect();
    const inside =
      event.clientX >= bounds.left &&
      event.clientX <= bounds.right &&
      event.clientY >= bounds.top &&
      event.clientY <= bounds.bottom;

    if (!inside) {
      onClose();
    }
  };

  return (
    <dialog
      ref={dialogRef}
      className="progress-dialog"
      data-testid={testId}
      aria-labelledby={titleId}
      aria-modal="true"
      onCancel={(event) => {
        event.preventDefault();

        if (!busy) {
          onClose();
        }
      }}
      onClick={closeFromBackdrop}
    >
      <div className="progress-dialog-handle" aria-hidden="true" />
      {children}
    </dialog>
  );
};

export interface GoalDialogProps {
  readonly currentGoal: SurveyGoal;
  readonly busy: boolean;
  readonly error: string | null;
  readonly onClose: () => void;
  readonly onSave: (goal: SurveyGoal) => void;
}

export const GoalDialog = ({
  currentGoal,
  busy,
  error,
  onClose,
  onSave,
}: GoalDialogProps): ReactNode => {
  const [selectedGoal, setSelectedGoal] = useState<SurveyGoal>(currentGoal);

  const submit = (event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault();

    if (!busy && selectedGoal !== currentGoal) {
      onSave(selectedGoal);
    }
  };

  return (
    <DialogShell
      testId="progress-goal-dialog"
      titleId="progress-goal-dialog-title"
      busy={busy}
      onClose={onClose}
    >
      <form className="progress-dialog-form" onSubmit={submit}>
        <h2 id="progress-goal-dialog-title">Изменить цель</h2>
        <fieldset className="progress-goal-options" disabled={busy}>
          <legend className="visually-hidden">Выберите новую цель</legend>
          {goalOptions.map(({ value, label }) => (
            <label
              key={value}
              className={`progress-goal-option${selectedGoal === value ? ' is-selected' : ''}`}
              data-testid={`progress-goal-option-${value}`}
            >
              <input
                type="radio"
                name="progress-goal"
                value={value}
                checked={selectedGoal === value}
                onChange={() => setSelectedGoal(value)}
              />
              <span className="progress-goal-radio" aria-hidden="true">
                {selectedGoal === value ? '✓' : ''}
              </span>
              <span>{label}</span>
            </label>
          ))}
        </fieldset>
        {error === null ? null : (
          <p className="progress-dialog-error" role="alert">
            {error}
          </p>
        )}
        <div className="progress-dialog-actions">
          <button
            className="primary-button"
            data-testid="progress-goal-save"
            type="submit"
            disabled={busy || selectedGoal === currentGoal}
          >
            {busy ? 'Сохраняем…' : 'Сохранить'}
          </button>
          <button className="secondary-button" type="button" disabled={busy} onClick={onClose}>
            Отмена
          </button>
        </div>
      </form>
    </DialogShell>
  );
};

interface RangeFieldProps {
  readonly metric: (typeof progressMetricConfigs)[number];
  readonly value: number;
  readonly disabled: boolean;
  readonly onChange: (value: number) => void;
}

const RangeField = ({ metric, value, disabled, onChange }: RangeFieldProps): ReactNode => {
  const inputId = `weekly-${metric.testId}`;
  const style = {
    '--range-progress': `${((value - 1) / 9) * 100}%`,
  } as CSSProperties;

  return (
    <div className="progress-range-field">
      <div className="progress-range-heading">
        <label htmlFor={inputId}>{metric.accessibleLabel}</label>
        <output data-testid={`${inputId}-value`} htmlFor={inputId}>
          {value}
        </output>
      </div>
      <input
        id={inputId}
        data-testid={inputId}
        style={style}
        type="range"
        min={1}
        max={10}
        step={1}
        value={value}
        disabled={disabled}
        aria-valuetext={`${value} из 10`}
        onChange={(event) => onChange(clampMetricScore(Number(event.currentTarget.value)))}
      />
    </div>
  );
};

export interface WeeklyMetricsDialogProps {
  readonly currentWeek: number;
  readonly busy: boolean;
  readonly error: string | null;
  readonly onClose: () => void;
  readonly onSave: (input: WeeklyMetricsInput) => void;
}

export const WeeklyMetricsDialog = ({
  currentWeek,
  busy,
  error,
  onClose,
  onSave,
}: WeeklyMetricsDialogProps): ReactNode => {
  const [scores, setScores] = useState({
    energy: 5,
    sleep: 5,
    mood: 5,
    body_satisfaction: 5,
  });
  const [note, setNote] = useState('');

  const submit = (event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault();

    if (busy) {
      return;
    }

    const cleanNote = normalizedNote(note);
    onSave({
      program_week: currentWeek,
      ...scores,
      ...(cleanNote === undefined ? {} : { note: cleanNote }),
    });
  };

  return (
    <DialogShell
      testId="progress-metrics-dialog"
      titleId="progress-metrics-dialog-title"
      busy={busy}
      onClose={onClose}
    >
      <form className="progress-dialog-form" onSubmit={submit}>
        <header className="progress-dialog-heading">
          <h2 id="progress-metrics-dialog-title">Оценить неделю</h2>
          <p>Неделя {currentWeek}</p>
        </header>
        <div className="progress-range-list">
          {progressMetricConfigs.map((metric) => (
            <RangeField
              key={metric.key}
              metric={metric}
              value={scores[metric.key]}
              disabled={busy}
              onChange={(value) => setScores((current) => ({ ...current, [metric.key]: value }))}
            />
          ))}
        </div>
        <label className="progress-note-field" htmlFor="weekly-note">
          <span>Заметка</span>
          <textarea
            id="weekly-note"
            data-testid="weekly-note"
            value={note}
            maxLength={500}
            rows={3}
            disabled={busy}
            placeholder="Можно оставить короткую заметку"
            onChange={(event) => setNote(event.currentTarget.value)}
          />
        </label>
        {error === null ? null : (
          <p className="progress-dialog-error" role="alert">
            {error}
          </p>
        )}
        <div className="progress-dialog-actions">
          <button
            className="primary-button"
            data-testid="weekly-save"
            type="submit"
            disabled={busy}
          >
            {busy ? 'Сохраняем…' : 'Сохранить'}
          </button>
          <button className="secondary-button" type="button" disabled={busy} onClick={onClose}>
            Отмена
          </button>
        </div>
      </form>
    </DialogShell>
  );
};
