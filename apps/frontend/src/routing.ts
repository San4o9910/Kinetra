import type { OnboardingStatus } from '@kinetra/shared';

export const appRoutes = Object.freeze({
  login: '/login',
  catalogue: '/catalog',
  trainerMarketplace: '/trainer/marketplace',
  adminMarketplace: '/admin/marketplace',
  survey: '/survey',
  onboarding: '/onboarding',
  baseLessons: '/base-lessons',
  home: '/',
  schedule: '/schedule',
  progress: '/progress',
  settings: '/settings',
  editSurvey: '/settings/survey',
  chat: '/chat',
  nutrition: '/nutrition',
  trainerProfile: '/trainer/profile',
  trainerChats: '/trainer/chats',
  trainerStudents: '/trainer/students',
  trainerLessons: '/trainer/lessons',
  myTraining: '/my-training',
  adminApplications: '/admin/trainer-applications',
  assistant: '/assistant',
  trainerVideos: '/trainer/videos',
  payment: '/payment',
  paymentSuccess: '/payment/success',
  paymentCancel: '/payment/cancel',
} as const);

export type StaticAppRoute = (typeof appRoutes)[keyof typeof appRoutes];
export type TrainerConversationRoute = `/trainer/chats/${string}`;
export type AppRoute =
  StaticAppRoute | TrainerConversationRoute | `/coaches/${string}` | `/offers/${string}`;

const knownRoutes = new Set<string>(Object.values(appRoutes));
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

export const routeForOnboardingStatus = (status: OnboardingStatus): AppRoute => {
  switch (status) {
    case 'survey_pending':
      return appRoutes.survey;
    case 'onboarding_pending':
      return appRoutes.onboarding;
    case 'base_lessons':
      return appRoutes.home;
    case 'active':
      return appRoutes.home;
  }
};

export const normalizeAppRoute = (pathname: string): AppRoute => {
  const normalized = pathname.length > 1 ? pathname.replace(/\/+$/u, '') : pathname;

  if (knownRoutes.has(normalized)) {
    return normalized as StaticAppRoute;
  }

  const trainerMatch = /^\/trainer\/chats\/([^/]+)$/u.exec(normalized);
  const marketMatch = /^\/(coaches|offers)\/([^/]+)$/u.exec(normalized);
  if (marketMatch?.[2] && UUID_PATTERN.test(marketMatch[2]))
    return `/${marketMatch[1]}/${marketMatch[2].toLowerCase()}` as AppRoute;

  if (trainerMatch?.[1] !== undefined && UUID_PATTERN.test(trainerMatch[1])) {
    return `/trainer/chats/${trainerMatch[1].toLowerCase()}`;
  }

  return appRoutes.login;
};

export const trainerConversationRoute = (conversationId: string): TrainerConversationRoute => {
  if (!UUID_PATTERN.test(conversationId)) {
    throw new Error('Trainer conversation ID must be a UUID.');
  }

  return `/trainer/chats/${conversationId.toLowerCase()}`;
};

export const trainerConversationIdFromRoute = (route: AppRoute): string | null => {
  const match = /^\/trainer\/chats\/([^/]+)$/u.exec(route);
  return match?.[1] !== undefined && UUID_PATTERN.test(match[1]) ? match[1].toLowerCase() : null;
};

export const isSettingsRoute = (route: AppRoute): boolean =>
  route === appRoutes.settings || route === appRoutes.editSurvey;

export const isPaymentRoute = (route: AppRoute): boolean =>
  route === appRoutes.payment ||
  route === appRoutes.paymentSuccess ||
  route === appRoutes.paymentCancel;

export const isTrainerRoute = (route: AppRoute): boolean =>
  route === appRoutes.trainerMarketplace ||
  route === appRoutes.trainerProfile ||
  route === appRoutes.trainerStudents ||
  route === appRoutes.trainerLessons ||
  route === appRoutes.trainerChats ||
  route === appRoutes.trainerVideos ||
  trainerConversationIdFromRoute(route) !== null;

export const isChatFabRoute = (route: AppRoute): boolean =>
  route === appRoutes.home ||
  route === appRoutes.schedule ||
  route === appRoutes.progress ||
  route === appRoutes.settings;

export const isActiveAppRoute = (route: AppRoute): boolean =>
  route === appRoutes.catalogue ||
  route === appRoutes.nutrition ||
  route === appRoutes.myTraining ||
  route === appRoutes.home ||
  route === appRoutes.schedule ||
  route === appRoutes.progress ||
  route === appRoutes.assistant ||
  isSettingsRoute(route);

export const isExplorationAppRoute = (route: AppRoute): boolean =>
  route === appRoutes.chat || route === appRoutes.baseLessons || isActiveAppRoute(route);

export const isMarketplaceRoute = (route: AppRoute): boolean =>
  route === appRoutes.catalogue || route.startsWith('/coaches/') || route.startsWith('/offers/');
export const consumeMarketplaceReturn = (): AppRoute | null => {
  try {
    const saved = sessionStorage.getItem('kinetra-market-return');
    sessionStorage.removeItem('kinetra-market-return');
    const route = normalizeAppRoute(saved ?? '');
    return isMarketplaceRoute(route) ? route : null;
  } catch {
    return null;
  }
};
