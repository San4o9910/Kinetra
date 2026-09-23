export const PROGRAM_WEEKS = 12;
export const PROGRAM_WORKOUTS = 84;

export const journeySummary = (totalWorkouts: number, currentWeek: number) => ({
  completed: Number.isFinite(totalWorkouts)
    ? Math.max(0, Math.min(PROGRAM_WORKOUTS, Math.trunc(totalWorkouts)))
    : 0,
  currentWeek: Number.isFinite(currentWeek)
    ? Math.max(1, Math.min(PROGRAM_WEEKS, Math.trunc(currentWeek)))
    : 1,
});
