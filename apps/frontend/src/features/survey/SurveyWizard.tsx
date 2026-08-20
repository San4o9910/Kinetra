import { useEffect, useMemo, useRef, useState, type ChangeEvent, type ReactNode } from 'react';
import type {
  MeResponse,
  SurveyAgeRange,
  SurveyAnswer,
  SurveyExperience,
  SurveyGender,
  SurveyGoal,
  SurveyInjury,
} from '@kinetra/shared';

import { saveSurvey } from '../../lib/api';
import {
  SURVEY_STEP_COUNT,
  createSurveyDraft,
  isSurveyStepValid,
  surveyDraftToSubmission,
  toggleSurveyInjury,
  type SurveyDraft,
} from './model';

interface SurveyWizardProps {
  readonly initialSurvey: SurveyAnswer | null;
  readonly onSaved: (profile: MeResponse) => void;
  readonly onCancel?: () => void;
}

interface Option<T extends string> {
  readonly value: T;
  readonly label: string;
  readonly description?: string;
}

const genderOptions: readonly Option<SurveyGender>[] = [
  { value: 'female', label: 'Женский' },
  { value: 'male', label: 'Мужской' },
];

const ageOptions: readonly Option<SurveyAgeRange>[] = [
  { value: '18-25', label: '18–25' },
  { value: '26-35', label: '26–35' },
  { value: '36-45', label: '36–45' },
  { value: '46-55', label: '46–55' },
  { value: '55+', label: '55+' },
];

const goalOptions: readonly Option<SurveyGoal>[] = [
  {
    value: 'flexibility',
    label: 'Гибкость',
    description: 'Больше свободы и лёгкости в движениях',
  },
  {
    value: 'strength',
    label: 'Сила',
    description: 'Укрепить мышцы и чувствовать опору',
  },
  {
    value: 'awareness',
    label: 'Осознанность',
    description: 'Лучше чувствовать тело и дыхание',
  },
  {
    value: 'general_health',
    label: 'Общее здоровье',
    description: 'Больше энергии и регулярного движения',
  },
];

const injuryOptions: readonly Option<SurveyInjury>[] = [
  { value: 'none', label: 'Нет ограничений' },
  { value: 'knees', label: 'Колени' },
  { value: 'lower_back', label: 'Поясница' },
  { value: 'shoulders', label: 'Плечи' },
  { value: 'neck', label: 'Шея' },
  { value: 'other', label: 'Другое' },
];

const experienceOptions: readonly Option<SurveyExperience>[] = [
  {
    value: 'beginner',
    label: 'Начинаю с нуля',
    description: 'Раньше почти не занимался(ась)',
  },
  {
    value: 'novice',
    label: 'Есть небольшой опыт',
    description: 'Занимался(ась), но нерегулярно',
  },
  {
    value: 'experienced',
    label: 'Занимаюсь уверенно',
    description: 'Тренировки — знакомая часть жизни',
  },
];

const questionTitles = [
  'Укажите ваш пол',
  'Выберите возрастной диапазон',
  'Какая у вас главная цель?',
  'Есть ли травмы или ограничения?',
  'Какой у вас опыт тренировок?',
] as const;

interface ChoiceGridProps<T extends string> {
  readonly label: string;
  readonly options: readonly Option<T>[];
  readonly value: T | null;
  readonly onChange: (value: T) => void;
}

const ChoiceGrid = <T extends string>({
  label,
  options,
  value,
  onChange,
}: ChoiceGridProps<T>): ReactNode => (
  <div className="survey-options" role="radiogroup" aria-label={label}>
    {options.map((option) => {
      const selected = option.value === value;

      return (
        <button
          className={`survey-option${selected ? ' is-selected' : ''}`}
          data-testid={`survey-option-${option.value}`}
          type="button"
          role="radio"
          aria-checked={selected}
          key={option.value}
          onClick={() => onChange(option.value)}
        >
          <span className="option-indicator" aria-hidden="true" />
          <span>
            <strong>{option.label}</strong>
            {option.description === undefined ? null : <small>{option.description}</small>}
          </span>
        </button>
      );
    })}
  </div>
);

export const SurveyWizard = ({
  initialSurvey,
  onSaved,
  onCancel,
}: SurveyWizardProps): ReactNode => {
  const [step, setStep] = useState(0);
  const [draft, setDraft] = useState<SurveyDraft>(() => createSurveyDraft(initialSurvey));
  const [isSaving, setIsSaving] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const questionHeadingRef = useRef<HTMLHeadingElement>(null);
  const isValid = useMemo(() => isSurveyStepValid(step, draft), [draft, step]);
  const isEditing = initialSurvey !== null;

  useEffect(() => {
    if (step > 0) {
      questionHeadingRef.current?.focus();
    }
  }, [step]);

  const setField = <K extends keyof SurveyDraft>(key: K, value: SurveyDraft[K]): void => {
    setDraft((current) => ({ ...current, [key]: value }));
    setSubmitError(null);
  };

  const save = async (): Promise<void> => {
    const submission = surveyDraftToSubmission(draft);

    if (submission === null) {
      setSubmitError('Ответьте на все обязательные вопросы.');
      return;
    }

    setIsSaving(true);
    setSubmitError(null);

    try {
      const profile = await saveSurvey(submission);
      onSaved(profile);
    } catch (error) {
      setSubmitError(
        error instanceof Error ? error.message : 'Не удалось сохранить анкету. Попробуйте ещё раз.',
      );
    } finally {
      setIsSaving(false);
    }
  };

  const progressPercent = Math.round(((step + 1) / SURVEY_STEP_COUNT) * 100);

  return (
    <main className="survey-shell" data-testid="survey-screen">
      <section className="survey-panel" aria-labelledby="survey-question">
        <header className="survey-header">
          <div className="survey-brand">
            <span className="survey-brand-mark" aria-hidden="true">
              K
            </span>
            <span>KINETRA</span>
          </div>
          <div className="survey-progress-copy" aria-live="polite">
            <span data-testid="survey-step">
              Шаг {step + 1} из {SURVEY_STEP_COUNT}
            </span>
            <strong>{progressPercent}%</strong>
          </div>
          <div
            className="survey-progress"
            role="progressbar"
            aria-label="Прогресс анкеты"
            aria-valuemin={1}
            aria-valuemax={SURVEY_STEP_COUNT}
            aria-valuenow={step + 1}
            aria-valuetext={`Шаг ${step + 1} из ${SURVEY_STEP_COUNT}`}
          >
            <span style={{ width: `${progressPercent}%` }} />
          </div>
        </header>

        <div className="survey-card">
          <p className="survey-intro" id="survey-intro">
            Чтобы мы могли подобрать программу, которая подходит именно вам, ответьте на несколько
            вопросов. Это займёт меньше минуты.
          </p>
          <p className="survey-kicker">
            {isEditing ? 'Редактирование анкеты' : 'Персональная программа'}
          </p>
          <h1 id="survey-question" ref={questionHeadingRef} tabIndex={-1}>
            {questionTitles[step]}
          </h1>

          <div className="survey-question-body" aria-describedby="survey-intro">
            {step === 0 ? (
              <ChoiceGrid
                label={questionTitles[0]}
                options={genderOptions}
                value={draft.gender}
                onChange={(value) => setField('gender', value)}
              />
            ) : null}

            {step === 1 ? (
              <ChoiceGrid
                label={questionTitles[1]}
                options={ageOptions}
                value={draft.ageRange}
                onChange={(value) => setField('ageRange', value)}
              />
            ) : null}

            {step === 2 ? (
              <ChoiceGrid
                label={questionTitles[2]}
                options={goalOptions}
                value={draft.goal}
                onChange={(value) => setField('goal', value)}
              />
            ) : null}

            {step === 3 ? (
              <>
                <div
                  className="survey-options injury-options"
                  role="group"
                  aria-label="Травмы и ограничения"
                >
                  {injuryOptions.map((option) => {
                    const selected = draft.injuries.includes(option.value);

                    return (
                      <button
                        className={`survey-option${selected ? ' is-selected' : ''}`}
                        data-testid={`survey-option-${option.value}`}
                        type="button"
                        aria-pressed={selected}
                        key={option.value}
                        onClick={() => {
                          setDraft((current) => toggleSurveyInjury(current, option.value));
                          setSubmitError(null);
                        }}
                      >
                        <span className="option-indicator option-checkbox" aria-hidden="true" />
                        <span>
                          <strong>{option.label}</strong>
                        </span>
                      </button>
                    );
                  })}
                </div>
                {draft.injuries.includes('other') ? (
                  <label className="survey-detail">
                    <span>Опишите ограничение</span>
                    <textarea
                      data-testid="injuries-detail"
                      value={draft.injuriesDetail}
                      onChange={(event: ChangeEvent<HTMLTextAreaElement>) =>
                        setField('injuriesDetail', event.target.value)
                      }
                      maxLength={500}
                      rows={4}
                      required
                      aria-describedby="injury-detail-hint"
                      placeholder="Например: старая травма голеностопа"
                    />
                  </label>
                ) : null}
                <p className="survey-hint" id="injury-detail-hint">
                  «Нет ограничений» нельзя выбрать вместе с другими вариантами. При выборе «Другое»
                  описание обязательно.
                </p>
              </>
            ) : null}

            {step === 4 ? (
              <ChoiceGrid
                label={questionTitles[4]}
                options={experienceOptions}
                value={draft.experience}
                onChange={(value) => setField('experience', value)}
              />
            ) : null}
          </div>

          {submitError === null ? null : (
            <p className="survey-error" role="alert">
              {submitError}
            </p>
          )}

          <footer className="survey-actions">
            <button
              className="secondary-button"
              data-testid="survey-back"
              type="button"
              disabled={step === 0 && onCancel === undefined}
              onClick={() => {
                if (step > 0) {
                  setStep((current) => current - 1);
                } else {
                  onCancel?.();
                }
              }}
            >
              {step === 0 && onCancel !== undefined ? 'Отмена' : 'Назад'}
            </button>

            {step < SURVEY_STEP_COUNT - 1 ? (
              <button
                className="primary-button"
                data-testid="survey-next"
                type="button"
                disabled={!isValid}
                onClick={() => setStep((current) => current + 1)}
              >
                Далее
              </button>
            ) : (
              <button
                className="primary-button"
                data-testid="survey-save"
                type="button"
                disabled={!isValid || isSaving}
                onClick={() => void save()}
              >
                {isSaving ? 'Сохраняем…' : 'Сохранить'}
              </button>
            )}
          </footer>
        </div>
      </section>
    </main>
  );
};
