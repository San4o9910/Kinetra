export const ONBOARDING_SLIDE_STORAGE_KEY = 'kinetra.onboarding.slide';
export const ONBOARDING_SLIDE_OWNER_STORAGE_KEY = 'kinetra.onboarding.user';
export const ONBOARDING_SWIPE_THRESHOLD = 48;
export const ONBOARDING_AXIS_LOCK_THRESHOLD = 8;
export const ONBOARDING_NEXT_LABEL = 'Далее';
export const ONBOARDING_COMPLETE_LABEL = 'К базовым урокам';

export interface OnboardingSlideCopy {
  readonly title: string;
  readonly subtitle?: string;
}

export interface WeekRhythm {
  readonly day: string;
  readonly label: string;
  readonly icon: 'breath' | 'strength' | 'home' | 'functional' | 'stretch' | 'neuro' | 'food';
}

export const onboardingSlides: readonly OnboardingSlideCopy[] = [
  {
    title: 'Добро пожаловать в Kinetra',
    subtitle:
      'Это не просто тренировки. Это образ жизни, который делает вас сильнее, гибче и энергичнее',
  },
  {
    title: 'Активность не тратит энергию. Она её создаёт',
    subtitle:
      'Каждое занятие — это вклад в вашу бодрость, ясность ума и уверенность в себе. Вы почувствуете разницу уже через 2 недели',
  },
  {
    title: '7 ритмов недели',
  },
  {
    title: 'Изучите базу',
    subtitle:
      'Мы научим вас 7 базовым движениям, которые лежат в основе любых тренировок. Это убережёт от травм и сделает каждое упражнение осмысленным',
  },
  {
    title: 'Вы сможете двигаться свободно и без боли',
    subtitle:
      'Подниматься по лестнице без одышки, носить сумки без напряжения в спине, играть с детьми и не бояться падений. Это и есть настоящая сила',
  },
  {
    title: 'Готовы начать?',
  },
] as const;

export const ONBOARDING_SLIDE_COUNT = onboardingSlides.length;

export const weekRhythms: readonly WeekRhythm[] = [
  { day: 'Пн', label: 'Дыхание', icon: 'breath' },
  { day: 'Вт', label: 'Сила', icon: 'strength' },
  { day: 'Ср', label: 'Тело мой дом', icon: 'home' },
  { day: 'Чт', label: 'Функционал', icon: 'functional' },
  { day: 'Пт', label: 'Растяжка', icon: 'stretch' },
  { day: 'Сб', label: 'Нейрогимнастика', icon: 'neuro' },
  { day: 'Вс', label: 'Питание', icon: 'food' },
] as const;

export const parseStoredOnboardingSlide = (value: string | null): number => {
  if (value === null || !/^\d+$/u.test(value)) {
    return 0;
  }

  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed >= 0 && parsed < ONBOARDING_SLIDE_COUNT ? parsed : 0;
};

export const parseStoredOnboardingSlideForUser = (
  value: string | null,
  storedUserId: string | null,
  currentUserId: string,
): number =>
  storedUserId === currentUserId && currentUserId.length > 0
    ? parseStoredOnboardingSlide(value)
    : 0;

export const slideAfterSwipe = (current: number, deltaX: number, deltaY = 0): number => {
  if (Math.abs(deltaY) >= Math.abs(deltaX)) {
    return current;
  }

  if (deltaX <= -ONBOARDING_SWIPE_THRESHOLD) {
    return Math.min(current + 1, ONBOARDING_SLIDE_COUNT - 1);
  }

  if (deltaX >= ONBOARDING_SWIPE_THRESHOLD) {
    return Math.max(current - 1, 0);
  }

  return current;
};
