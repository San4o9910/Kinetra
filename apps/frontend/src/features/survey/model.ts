import type {
  SurveyAgeRange,
  SurveyAnswer,
  SurveyExperience,
  SurveyGender,
  SurveyGoal,
  SurveyInjury,
  SurveySubmission,
} from '@kinetra/shared';

export const SURVEY_STEP_COUNT = 5;

export interface SurveyDraft {
  readonly gender: SurveyGender | null;
  readonly ageRange: SurveyAgeRange | null;
  readonly goal: SurveyGoal | null;
  readonly injuries: readonly SurveyInjury[];
  readonly injuriesDetail: string;
  readonly experience: SurveyExperience | null;
}

export const createSurveyDraft = (survey: SurveyAnswer | null): SurveyDraft => ({
  gender: survey?.gender ?? null,
  ageRange: survey?.age_range ?? null,
  goal: survey?.goal ?? null,
  injuries: survey?.injuries ?? [],
  injuriesDetail: survey?.injuries_detail ?? '',
  experience: survey?.experience ?? null,
});

export const isSurveyStepValid = (step: number, draft: SurveyDraft): boolean => {
  switch (step) {
    case 0:
      return draft.gender !== null;
    case 1:
      return draft.ageRange !== null;
    case 2:
      return draft.goal !== null;
    case 3: {
      if (draft.injuries.length === 0) {
        return false;
      }

      if (new Set(draft.injuries).size !== draft.injuries.length) {
        return false;
      }

      if (draft.injuries.includes('none') && draft.injuries.length !== 1) {
        return false;
      }

      if (draft.injuries.includes('other')) {
        const detailLength = draft.injuriesDetail.trim().length;
        return detailLength >= 1 && detailLength <= 500;
      }

      return draft.injuriesDetail.trim().length === 0;
    }
    case 4:
      return draft.experience !== null;
    default:
      return false;
  }
};

export const toggleSurveyInjury = (draft: SurveyDraft, injury: SurveyInjury): SurveyDraft => {
  if (injury === 'none') {
    return {
      ...draft,
      injuries: draft.injuries.includes('none') ? [] : ['none'],
      injuriesDetail: '',
    };
  }

  const withoutNone = draft.injuries.filter((item) => item !== 'none');
  const injuries = withoutNone.includes(injury)
    ? withoutNone.filter((item) => item !== injury)
    : [...withoutNone, injury];

  return {
    ...draft,
    injuries,
    injuriesDetail: injuries.includes('other') ? draft.injuriesDetail : '',
  };
};

export const surveyDraftToSubmission = (draft: SurveyDraft): SurveySubmission | null => {
  const allStepsValid = Array.from({ length: SURVEY_STEP_COUNT }, (_, step) =>
    isSurveyStepValid(step, draft),
  ).every(Boolean);

  if (
    !allStepsValid ||
    draft.gender === null ||
    draft.ageRange === null ||
    draft.goal === null ||
    draft.experience === null
  ) {
    return null;
  }

  const baseSubmission: SurveySubmission = {
    gender: draft.gender,
    age_range: draft.ageRange,
    goal: draft.goal,
    injuries: [...draft.injuries],
    experience: draft.experience,
  };

  return draft.injuries.includes('other')
    ? {
        ...baseSubmission,
        injuries_detail: draft.injuriesDetail.trim(),
      }
    : baseSubmission;
};
