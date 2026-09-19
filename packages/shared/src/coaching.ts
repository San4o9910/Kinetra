export type FoodUnit = 'g' | 'ml' | 'piece';
export type MealSlot = 'breakfast' | 'lunch' | 'dinner' | 'snack';
export interface FoodPortion {
  name: string;
  quantity: number;
  unit: FoodUnit;
}
export interface MealContents {
  slot: MealSlot;
  title: string;
  items: FoodPortion[];
}
export interface NutritionEntryInput extends MealContents {
  recorded_date: string;
  note: string;
  share_with_trainer: boolean;
  revision: number;
}
export interface NutritionEntry extends NutritionEntryInput {
  id: string;
  photo_id: string | null;
}
export interface NutritionTemplate {
  id: string;
  name: string;
  kind: 'portion' | 'meal' | 'day';
  meals: MealContents[];
}
export interface CoachMetrics {
  active_students: number;
  ready_lessons: number;
  review_count: number;
  rating: number | null;
}
export interface CoachProfile extends CoachMetrics {
  display_name: string;
  level: string;
  next_level: string | null;
}
export const COACH_LEVELS = [
  { name: 'Старт', students: 0, lessons: 0, reviews: 0, rating: 0 },
  { name: 'Практик', students: 7, lessons: 5, reviews: 3, rating: 4 },
  { name: 'Наставник', students: 14, lessons: 15, reviews: 5, rating: 4.3 },
  { name: 'Мастер', students: 25, lessons: 30, reviews: 10, rating: 4.6 },
] as const;
export const coachLevel = (m: CoachMetrics) => {
  let index = 0;
  COACH_LEVELS.forEach((level, i) => {
    if (
      m.active_students >= level.students &&
      m.ready_lessons >= level.lessons &&
      m.review_count >= level.reviews &&
      (m.rating ?? 0) >= level.rating
    )
      index = i;
  });
  return { level: COACH_LEVELS[index]!.name, next_level: COACH_LEVELS[index + 1]?.name ?? null };
};
export const COACH_PACKAGES = [
  { id: 'start', name: 'Старт', seats: 7, perSeat: 175, extraSeat: 200 },
  { id: 'practice', name: 'Практика', seats: 14, perSeat: 160, extraSeat: 200 },
  { id: 'team', name: 'Команда', seats: 25, perSeat: 145, extraSeat: 200 },
  { id: 'large', name: 'Большая практика', seats: 30, perSeat: 130, extraSeat: 150 },
] as const;
export const coachPackageQuote = (id: string, baseSeats = 30, extraSeats = 0) => {
  const plan = COACH_PACKAGES.find((p) => p.id === id);
  if (
    !plan ||
    !Number.isInteger(extraSeats) ||
    extraSeats < 0 ||
    extraSeats > 500 ||
    !Number.isInteger(baseSeats) ||
    baseSeats < 30 ||
    baseSeats > 500
  )
    throw new Error('Invalid package');
  const seats = plan.id === 'large' ? baseSeats : plan.seats;
  if (seats + extraSeats > 500) throw new Error('Package exceeds workspace capacity');
  const monthly = seats * plan.perSeat + extraSeats * plan.extraSeat;
  return {
    seats: seats + extraSeats,
    monthly,
    introductory: Math.round(monthly * 0.6),
    extra: extraSeats * plan.extraSeat,
  };
};
