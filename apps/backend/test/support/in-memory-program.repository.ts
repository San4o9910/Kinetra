import {
  PROGRAM_DAYS_PER_WEEK,
  PROGRAM_WEEK_COUNT,
  type CompleteWorkoutResult,
  type ProgramDaySnapshot,
  type ProgramProgressSnapshot,
  type ProgramRepository,
  type ProgramWeekSnapshot,
} from '../../src/program/repository.js';

const daySchedule = [
  {
    direction: 'breathing',
    title: 'Дыхание',
    description: 'Практика дыхания и контроля тела.',
    durationMinutes: 25,
    icon: 'wind',
  },
  {
    direction: 'strength',
    title: 'Сила',
    description: 'Силовая тренировка с постепенным ростом нагрузки.',
    durationMinutes: 35,
    icon: 'dumbbell',
  },
  {
    direction: 'body_therapy',
    title: 'Телесная терапия',
    description: 'Мягкая работа с подвижностью и ощущениями тела.',
    durationMinutes: 30,
    icon: 'heart-pulse',
  },
  {
    direction: 'functional',
    title: 'Функциональная тренировка',
    description: 'Комплекс на координацию, силу и выносливость.',
    durationMinutes: 35,
    icon: 'activity',
  },
  {
    direction: 'stretching',
    title: 'Растяжка',
    description: 'Спокойная работа над гибкостью и расслаблением.',
    durationMinutes: 30,
    icon: 'move',
  },
  {
    direction: 'neuro',
    title: 'Нейрогимнастика',
    description: 'Короткая тренировка внимания, баланса и координации.',
    durationMinutes: 15,
    icon: 'brain',
  },
  {
    direction: 'recovery',
    title: 'Восстановление',
    description: 'Восстановительная практика без высокой нагрузки.',
    durationMinutes: 20,
    icon: 'moon',
  },
] as const;

const uuidFor = (prefix: number, value: number): string =>
  `${prefix}0000000-0000-4000-8000-${String(value).padStart(12, '0')}`;

interface WeekFixture {
  readonly id: string;
  readonly weekNumber: number;
  readonly title: string;
  readonly days: readonly Omit<ProgramDaySnapshot, 'completedAt'>[];
}

export class InMemoryProgramRepository implements ProgramRepository {
  private readonly weeks: readonly WeekFixture[];
  private readonly completions = new Map<string, Date>();
  private readonly availableMedia = new Set<string>();

  public constructor(private readonly userId: string) {
    this.weeks = Array.from({ length: PROGRAM_WEEK_COUNT }, (_, weekIndex) => {
      const weekNumber = weekIndex + 1;

      return {
        id: uuidFor(2, weekNumber),
        weekNumber,
        title: `Неделя ${weekNumber}`,
        days: daySchedule.map((day, dayIndex) => {
          const dayOfWeek = dayIndex + 1;
          const absoluteDay = weekIndex * PROGRAM_DAYS_PER_WEEK + dayOfWeek;

          return {
            id: uuidFor(3, absoluteDay),
            dayOfWeek,
            direction: day.direction,
            title: day.title,
            description: day.description,
            durationMinutes: day.durationMinutes,
            icon: day.icon,
            videoId: uuidFor(4, absoluteDay),
            storageKey: `videos/workouts/week-${String(weekNumber).padStart(2, '0')}/day-${dayOfWeek}.mp4`,
            posterKey: `posters/workouts/week-${String(weekNumber).padStart(2, '0')}/day-${dayOfWeek}.jpg`,
            mediaAvailable: false,
          };
        }),
      };
    });
  }

  public async getProgress(userId: string): Promise<ProgramProgressSnapshot> {
    if (userId !== this.userId) {
      return {
        currentWeekNumber: 1,
        totalWeeks: PROGRAM_WEEK_COUNT,
        weeksCompleted: 0,
        totalWorkoutsDone: 0,
      };
    }

    const completionCounts = new Map<number, number>();

    for (const key of this.completions.keys()) {
      const weekNumber = Number(key.split(':', 1)[0]);
      completionCounts.set(weekNumber, (completionCounts.get(weekNumber) ?? 0) + 1);
    }

    const latestWeek = Math.max(0, ...completionCounts.keys());
    const currentWeekNumber =
      latestWeek === 0
        ? 1
        : Math.min(
            latestWeek + ((completionCounts.get(latestWeek) ?? 0) >= PROGRAM_DAYS_PER_WEEK ? 1 : 0),
            PROGRAM_WEEK_COUNT,
          );

    return {
      currentWeekNumber,
      totalWeeks: PROGRAM_WEEK_COUNT,
      weeksCompleted: [...completionCounts.values()].filter(
        (total) => total >= PROGRAM_DAYS_PER_WEEK,
      ).length,
      totalWorkoutsDone: this.completions.size,
    };
  }

  public async getWeek(userId: string, weekNumber: number): Promise<ProgramWeekSnapshot | null> {
    const week = this.weeks.find((candidate) => candidate.weekNumber === weekNumber);

    if (week === undefined) {
      return null;
    }

    return {
      id: week.id,
      weekNumber: week.weekNumber,
      title: week.title,
      days: week.days.map((day) => ({
        ...day,
        mediaAvailable: this.availableMedia.has(this.completionKey(weekNumber, day.videoId)),
        completedAt:
          userId === this.userId
            ? (this.completions.get(this.completionKey(weekNumber, day.videoId)) ?? null)
            : null,
      })),
    };
  }

  public async completeWorkout(
    userId: string,
    videoId: string,
    programWeek: number,
  ): Promise<CompleteWorkoutResult> {
    const week = this.weeks.find((candidate) => candidate.weekNumber === programWeek);

    if (
      userId !== this.userId ||
      week === undefined ||
      !week.days.some((day) => day.videoId === videoId)
    ) {
      return { kind: 'workout_not_found' };
    }

    const key = this.completionKey(programWeek, videoId);
    const inserted = !this.completions.has(key);

    if (inserted) {
      this.completions.set(key, new Date('2026-08-20T12:00:00.000Z'));
    }

    return { kind: 'completed', inserted };
  }

  public videoIdsForWeek(weekNumber: number): readonly string[] {
    return (
      this.weeks
        .find((candidate) => candidate.weekNumber === weekNumber)
        ?.days.map((day) => day.videoId) ?? []
    );
  }

  public markMediaAvailable(weekNumber: number, videoId: string): void {
    this.availableMedia.add(this.completionKey(weekNumber, videoId));
  }

  private completionKey(weekNumber: number, videoId: string): string {
    return `${weekNumber}:${videoId}`;
  }
}
