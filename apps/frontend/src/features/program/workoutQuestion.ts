import type { ProgramDay } from '@kinetra/shared';

const prefix = 'kinetra.workout.question.v1:';
export const formatWorkoutTime = (seconds: number): string => {
  const value = Math.max(0, Math.floor(Number.isFinite(seconds) ? seconds : 0));
  return `${Math.floor(value / 60)}:${String(value % 60).padStart(2, '0')}`;
};
export const prepareWorkoutQuestion = (
  accountId: string,
  day: ProgramDay,
  week: number,
  seconds: number,
): string => {
  const text = `Вопрос по тренировке «${day.title}», неделя ${week}, момент ${formatWorkoutTime(seconds)}.\n`;
  try {
    sessionStorage.setItem(prefix + accountId, text);
  } catch {
    /* Composer stays usable when storage is blocked. */
  }
  return text;
};
export const peekWorkoutQuestion = (accountId: string): string => {
  try {
    return sessionStorage.getItem(prefix + accountId) ?? '';
  } catch {
    return '';
  }
};
export const clearWorkoutQuestion = (accountId: string): void => {
  try {
    sessionStorage.removeItem(prefix + accountId);
  } catch {
    /* Best-effort cleanup. */
  }
};

export const prepareExerciseQuestion = (
  accountId: string,
  workout: string,
  exercise: string,
): string => {
  const text = `Вопрос по тренировке «${workout}», упражнение «${exercise}».\n`;
  try {
    sessionStorage.setItem(prefix + accountId, text);
  } catch {
    /* Draft stays optional. */
  }
  return text;
};
