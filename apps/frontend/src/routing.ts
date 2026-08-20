import type { OnboardingStatus } from '@kinetra/shared';

export const appRoutes = Object.freeze({
  login: '/login',
  survey: '/survey',
  onboarding: '/onboarding',
  baseLessons: '/base-lessons',
  home: '/',
  settings: '/settings',
  editSurvey: '/settings/survey',
} as const);

export type AppRoute = (typeof appRoutes)[keyof typeof appRoutes];

const knownRoutes = new Set<AppRoute>(Object.values(appRoutes));

export const routeForOnboardingStatus = (status: OnboardingStatus): AppRoute => {
  switch (status) {
    case 'survey_pending':
      return appRoutes.survey;
    case 'onboarding_pending':
      return appRoutes.onboarding;
    case 'base_lessons':
      return appRoutes.baseLessons;
    case 'active':
      return appRoutes.home;
  }
};

export const normalizeAppRoute = (pathname: string): AppRoute => {
  const normalized = pathname.length > 1 ? pathname.replace(/\/+$/u, '') : pathname;
  return knownRoutes.has(normalized as AppRoute) ? (normalized as AppRoute) : appRoutes.login;
};

export const isSettingsRoute = (route: AppRoute): boolean =>
  route === appRoutes.settings || route === appRoutes.editSurvey;
