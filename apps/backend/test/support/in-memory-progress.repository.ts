import type { SurveyGoal } from '@kinetra/shared';

import type {
  AchievementSnapshot,
  ProgressDashboardSnapshot,
  ProgressRepository,
  ProgressStatsSnapshot,
  ProgressSurveySnapshot,
  WeeklyMetricInput,
  WeeklyMetricSnapshot,
} from '../../src/progress/repository.js';

interface SurveyVersion {
  readonly version: number;
  readonly isCurrent: boolean;
  readonly survey: ProgressSurveySnapshot;
}

const cloneSurvey = (survey: ProgressSurveySnapshot): ProgressSurveySnapshot => ({
  ...survey,
  injuries: [...survey.injuries],
  createdAt: new Date(survey.createdAt),
  updatedAt: new Date(survey.updatedAt),
});

const cloneMetric = (metric: WeeklyMetricSnapshot): WeeklyMetricSnapshot => ({
  ...metric,
  createdAt: new Date(metric.createdAt),
});

const cloneAchievement = (achievement: AchievementSnapshot): AchievementSnapshot => ({
  ...achievement,
  unlockedAt: achievement.unlockedAt === null ? null : new Date(achievement.unlockedAt),
});

const canonicalAchievements: readonly AchievementSnapshot[] = [
  {
    code: 'first_base_lesson',
    title: 'Первый шаг',
    description: 'Просмотрен первый базовый урок',
    iconKey: '🎯',
    ruleType: 'base_lessons_viewed',
    ruleValue: 1,
    currentValue: 0,
    unlockedAt: null,
  },
  {
    code: 'base_unlocked',
    title: 'База пройдена',
    description: '4 базовых урока завершены',
    iconKey: '🔓',
    ruleType: 'base_lessons_viewed',
    ruleValue: 4,
    currentValue: 0,
    unlockedAt: null,
  },
  {
    code: 'first_workout',
    title: 'Первая тренировка',
    description: 'Первая тренировка из программы',
    iconKey: '💪',
    ruleType: 'workouts_completed',
    ruleValue: 1,
    currentValue: 0,
    unlockedAt: null,
  },
  {
    code: 'week_complete',
    title: 'Неделя завершена',
    description: 'Все 7 дней за неделю',
    iconKey: '🏆',
    ruleType: 'week_days_completed',
    ruleValue: 7,
    currentValue: 0,
    unlockedAt: null,
  },
  {
    code: 'streak_3',
    title: 'Три подряд',
    description: '3 тренировки подряд',
    iconKey: '🔥',
    ruleType: 'workout_streak',
    ruleValue: 3,
    currentValue: 0,
    unlockedAt: null,
  },
];

export class InMemoryProgressRepository implements ProgressRepository {
  private readonly metrics = new Map<number, WeeklyMetricSnapshot>();
  private readonly achievements = canonicalAchievements.map(cloneAchievement);
  private surveyVersions: SurveyVersion[] = [
    {
      version: 1,
      isCurrent: true,
      survey: {
        goal: 'flexibility',
        gender: 'male',
        ageRange: '26-35',
        experience: 'beginner',
        injuries: ['knees'],
        injuriesDetail: null,
        createdAt: new Date('2026-01-15T10:00:00.000Z'),
        updatedAt: new Date('2026-01-15T10:00:00.000Z'),
      },
    },
  ];
  private stats: ProgressStatsSnapshot = {
    totalWorkouts: 0,
    totalWeeksCompleted: 0,
    currentStreak: 0,
    bestStreak: 0,
    totalMinutesTrained: 0,
  };

  public constructor(private readonly userId: string) {}

  public async getDashboard(userId: string): Promise<ProgressDashboardSnapshot | null> {
    const survey = this.currentSurvey(userId);

    if (survey === null) {
      return null;
    }

    this.materializeAchievements();

    return {
      survey,
      metrics: await this.getRequiredMetrics(),
      achievements: this.achievements.map(cloneAchievement),
      stats: { ...this.stats },
    };
  }

  public async getMetrics(userId: string): Promise<readonly WeeklyMetricSnapshot[] | null> {
    if (userId !== this.userId) {
      return null;
    }

    return this.getRequiredMetrics();
  }

  public async upsertWeeklyMetrics(userId: string, input: WeeklyMetricInput): Promise<boolean> {
    if (userId !== this.userId) {
      return false;
    }

    const existing = this.metrics.get(input.programWeek);
    this.metrics.set(input.programWeek, {
      ...input,
      createdAt:
        existing?.createdAt ??
        new Date(`2026-02-${String(input.programWeek).padStart(2, '0')}T18:00:00.000Z`),
    });
    return true;
  }

  public async updateGoalVersion(
    userId: string,
    goal: SurveyGoal,
  ): Promise<ProgressSurveySnapshot | null> {
    const current = this.currentSurvey(userId);

    if (current === null) {
      return null;
    }

    this.surveyVersions = this.surveyVersions.map((version) => ({
      ...version,
      isCurrent: false,
    }));
    const version = this.surveyVersions.length + 1;
    const timestamp = new Date(`2026-03-${String(version).padStart(2, '0')}T10:00:00.000Z`);
    const survey: ProgressSurveySnapshot = {
      ...current,
      goal,
      injuries: [...current.injuries],
      createdAt: timestamp,
      updatedAt: timestamp,
    };
    this.surveyVersions.push({ version, isCurrent: true, survey });
    return cloneSurvey(survey);
  }

  public clearSurvey(): void {
    this.surveyVersions = [];
  }

  public setStats(stats: ProgressStatsSnapshot): void {
    this.stats = { ...stats };
  }

  public setAchievementProgress(code: string, currentValue: number): void {
    const index = this.achievements.findIndex((achievement) => achievement.code === code);

    if (index === -1) {
      throw new Error(`Unknown achievement ${code}.`);
    }

    const achievement = this.achievements[index] as AchievementSnapshot;
    this.achievements[index] = { ...achievement, currentValue };
  }

  public unlockAchievement(code: string, unlockedAt: Date): void {
    const index = this.achievements.findIndex((achievement) => achievement.code === code);

    if (index === -1) {
      throw new Error(`Unknown achievement ${code}.`);
    }

    const achievement = this.achievements[index] as AchievementSnapshot;
    this.achievements[index] = { ...achievement, unlockedAt: new Date(unlockedAt) };
  }

  public peekSurveyVersions(): readonly {
    readonly version: number;
    readonly isCurrent: boolean;
    readonly survey: ProgressSurveySnapshot;
  }[] {
    return this.surveyVersions.map((version) => ({
      ...version,
      survey: cloneSurvey(version.survey),
    }));
  }

  private currentSurvey(userId: string): ProgressSurveySnapshot | null {
    if (userId !== this.userId) {
      return null;
    }

    const current = this.surveyVersions.find((version) => version.isCurrent);
    return current === undefined ? null : cloneSurvey(current.survey);
  }

  private async getRequiredMetrics(): Promise<readonly WeeklyMetricSnapshot[]> {
    return [...this.metrics.values()]
      .sort((left, right) => left.programWeek - right.programWeek)
      .map(cloneMetric);
  }

  private materializeAchievements(): void {
    for (const [index, achievement] of this.achievements.entries()) {
      if (achievement.unlockedAt === null && achievement.currentValue >= achievement.ruleValue) {
        this.achievements[index] = {
          ...achievement,
          unlockedAt: new Date(`2026-04-${String(index + 1).padStart(2, '0')}T12:00:00.000Z`),
        };
      }
    }
  }
}
