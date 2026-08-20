import { useMemo, useState, type ChangeEvent, type ReactNode } from 'react';
import type {
  MeResponse,
  SurveyAgeRange,
  SurveyAnswer,
  SurveyExperience,
  SurveyGender,
  SurveyGoal,
  SurveyInjury,
  SurveySubmission,
} from '@kinetra/shared';

import { saveSurvey } from '../../lib/api';

interface SurveyWizardProps {
  readonly initialSurvey: SurveyAnswer | null;
  readonly onSaved: (profile: MeResponse) => void;
  readonly onCancel?: () => void;
}

interface SurveyDraft {
  readonly gender: SurveyGender | null;
  readonly age_range: SurveyAgeRange | null;
  readonly goal: SurveyGoal | null;
  readonly injuries: readonly SurveyInjury[];
  readonly injuries_detail: string;
  readonly experience: SurveyExperience | null;
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

const fromSurvey = (survey: SurveyAnswer | null): SurveyDraft => ({
  gender: survey?.gender ?? null,
  age_range: survey?.age_range ?? null,
  goal: survey?.goal ?? null,
  injuries: survey?.injuries ?? [],
  injuries_detail: survey?.injuries_detail ?? '',
  experience: survey?.experience ?? null,
});

const isStepValid = (step: number, draft: SurveyDraft): boolean => {
  switch (step) {
    case 0:
      return draft.gender !== null;
    case 1:
      return draft.age_range !== null;
    case 2:
      return draft.goal !== null;
    case 3: {
      if (draft.injuries.length === 0) {
        return false;
      }

      if (draft.injuries.includes('none') && draft.injuries.length > 1) {
        return false;
      }

      return !draft.injuries.includes('other') || draft.injuries_detail.trim().length > 0;
    }
    case 4:
      return draft.experience !== null;
    default:
      return false;
  }
};

const toSubmission = (draft: SurveyDraft): SurveySubmission | null => {
  if (
    draft.gender === null ||
    draft.age_range === null ||
    draft.goal === null ||
    draft.injuries.length === 0 ||
    draft.experience === null
  ) {
    return null;
  }

  const submission = {
    gender: draft.gender,
    age_range: draft.age_range,
    goal: draft.goal,
    injuries: [...draft.injuries],
    experience: draft.experience,
  } satisfies SurveySubmission;

  return draft.injuries.includes('other')
    ? {
        ...submission,
        injuries_detail: draft.injuries_detail.trim(),
      }
    : submission;
};

interface ChoiceGridProps<T extends string> {
  readonly options: readonly Option<T>[];
  readonly value: T | null;
  readonly onChange: (value: T) => void;
}

const ChoiceGrid = <T extends string,>({
  options,
  value,
  onChange,
}: ChoiceGridProps<T>): ReactNode => (
  <div className="survey-options" role="radiogroup">
    {options.map((option) => {
      const selected = option.value === value;

      return (
        <button
          className={`survey-option${selected ? ' is-selected' : ''}`}
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
  const [draft, setDraft] = useState<SurveyDraft>(() => fromSurvey(initialSurvey));
  const [isSaving, setIsSaving] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const isValid = useMemo(() => isStepValid(step, draft), [draft, step]);
  const isEditing = initialSurvey !== null;

  const setField = <K extends keyof SurveyDraft>(key: K, value: SurveyDraft[K]): void => {
    setDraft((current) => ({ ...current, [key]: value }));
    setSubmitError(null);
  };

  const toggleInjury = (injury: SurveyInjury): void => {
    setDraft((current) => {
      if (injury === 'none') {
        return {
          ...current,
          injuries: current.injuries.includes('none') ? [] : ['none'],
          injuries_detail: '',
        };
      }

      const withoutNone = current.injuries.filter((item) => item !== 'none');
      const injuries = withoutNone.includes(injury)
        ? withoutNone.filter((item) => item !== injury)
        : [...withoutNone, injury];

      return {
        ...current,
        injuries,
        injuries_detail: injuries.includes('other') ? current.injuries_detail : '',
      };
    });
    setSubmitError(null);
  };

  const handleDetailChange = (event: ChangeEvent<HTMLTextAreaElement>): void => {
    setField('injuries_detail', event.target.value);
  };

  const save = async (): Promise<void> => {
    const submission = toSubmission(draft);

    if (submission === null || !isStepValid(4, draft)) {
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
        error instanceof Error
          ? error.message
          : 'Не удалось сохранить анкету. Попробуйте ещё раз.',
      );
    } finally {
      setIsSaving(false);
    }
  };

  return (
    <main className="survey-shell">
      <section className="survey-panel" aria-labelledby="survey-question">
        <header className="survey-header">
          <div className="survey-brand">
            <span className="survey-brand-mark" aria-hidden="true">
              K
            </span>
            <span>KINETRA</span>
          </div>
          <div className="survey-progress-copy">
            <span>
              Шаг {step + 1} из {questionTitles.length}
            </span>
            <strong>{Math.round(((step + 1) / questionTitles.length) * 100)}%</strong>
          </div>
          <div
            className="survey-progress"
            role="progressbar"
            aria-valuemin={1}
            aria-valuemax={questionTitles.length}
            aria-valuenow={step + 1}
          >
            <span style={{ width: `${((step + 1) / questionTitles.length) * 100}%` }} />
          </div>
        </header>

        <div className="survey-card">
          <p className="survey-intro">
            Чтобы мы могли подобрать программу, которая подходит именно вам, ответьте на
            несколько вопросов. Это займёт меньше минуты.
          </p>
          <p className="survey-kicker">
            {isEditing ? 'Редактирование анкеты' : 'Персональная программа'}
          </p>
          <h1 id="survey-question">{questionTitles[step]}</h1>

          <div className="survey-question-body">
            {step === 0 ? (
              <ChoiceGrid
                options={genderOptions}
                value={draft.gender}
                onChange={(value) => setField('gender', value)}
              />
            ) : null}

            {step === 1 ? (
              <ChoiceGrid
                options={ageOptions}
                value={draft.age_range}
                onChange={(value) => setField('age_range', value)}
              />
            ) : null}

            {step === 2 ? (
              <ChoiceGrid
                options={goalOptions}
                value={draft.goal}
                onChange={(value) => setField('goal', value)}
              />
            ) : null}

            {step === 3 ? (
              <>
                <div className="survey-options injury-options" aria-label="Травмы и ограничения">
                  {injuryOptions.map((option) => {
                    const selected = draft.injuries.includes(option.value);

                    return (
                      <button
                        className={`survey-option${selected ? ' is-selected' : ''}`}
                        type="button"
                        aria-pressed={selected}
                        key={option.value}
                        onClick={() => toggleInjury(option.value)}
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
                      value={draft.injuries_detail}
                      onChange={handleDetailChange}
                      maxLength={500}
                      rows={4}
                      placeholder="Например: старая травма голеностопа"
                    />
                  </label>
                ) : null}
                <p className="survey-hint">
                  «Нет ограничений» нельзя выбрать вместе с другими вариантами.
                </p>
              </>
            ) : null}

            {step === 4 ? (
              <ChoiceGrid
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

            {step < questionTitles.length - 1 ? (
              <button
                className="primary-button"
                type="button"
                disabled={!isValid}
                onClick={() => setStep((current) => current + 1)}
              >
                Далее
              </button>
            ) : (
              <button
                className="primary-button"
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
