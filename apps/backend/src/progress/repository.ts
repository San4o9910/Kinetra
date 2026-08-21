import type {
  SurveyAgeRange,
  SurveyExperience,
  SurveyGender,
  SurveyGoal,
  SurveyInjury,
} from '@kinetra/shared';

export interface ProgressSurveySnapshot {
  readonly goal: SurveyGoal;
  readonly gender: SurveyGender;
  readonly ageRange: SurveyAgeRange;
  readonly experience: SurveyExperience;
  readonly injuries: readonly SurveyInjury[];
  readonly injuriesDetail: string | null;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

export interface WeeklyMetricInput {
  readonly programWeek: number;
  readonly energy: number;
  readonly sleep: number;
  readonly mood: number;
  readonly bodySatisfaction: number;
  readonly note: string | null;
}

export interface WeeklyMetricSnapshot extends WeeklyMetricInput {
  readonly createdAt: Date;
}

export type AchievementRuleType =
  'base_lessons_viewed' | 'workouts_completed' | 'week_days_completed' | 'workout_streak';

export interface AchievementSnapshot {
  readonly code: string;
  readonly title: string;
  readonly description: string | null;
  readonly iconKey: string;
  readonly ruleType: AchievementRuleType;
  readonly ruleValue: number;
  readonly currentValue: number;
  readonly unlockedAt: Date | null;
}

export interface ProgressStatsSnapshot {
  readonly totalWorkouts: number;
  readonly totalWeeksCompleted: number;
  readonly currentStreak: number;
  readonly bestStreak: number;
  readonly totalMinutesTrained: number;
}

export interface ProgressDashboardSnapshot {
  readonly survey: ProgressSurveySnapshot;
  readonly metrics: readonly WeeklyMetricSnapshot[];
  readonly achievements: readonly AchievementSnapshot[];
  readonly stats: ProgressStatsSnapshot;
}

export interface ProgressRepository {
  getDashboard(userId: string): Promise<ProgressDashboardSnapshot | null>;
  getMetrics(userId: string): Promise<readonly WeeklyMetricSnapshot[] | null>;
  upsertWeeklyMetrics(userId: string, input: WeeklyMetricInput): Promise<boolean>;
  updateGoalVersion(userId: string, goal: SurveyGoal): Promise<ProgressSurveySnapshot | null>;
}
