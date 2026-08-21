import type {
  GoalResponse,
  LockedAchievement,
  MetricsResponse,
  ProgressAchievements,
  ProgressGoal,
  ProgressMetrics,
  ProgressParams,
  ProgressResponse,
  ProgressStats,
  UnlockedAchievement,
  WeeklyMetric,
} from '@kinetra/shared';

import { HttpError } from '../auth/errors.js';
import type { ProgramProgressSnapshot, ProgramRepository } from '../program/repository.js';
import type {
  AchievementSnapshot,
  ProgressDashboardSnapshot,
  ProgressRepository,
  ProgressSurveySnapshot,
  WeeklyMetricSnapshot,
} from './repository.js';
import { progressGoalSchema, weeklyMetricsSchema } from './schema.js';

const goalLabels = Object.freeze({
  flexibility: 'Хочу быть гибким и подвижным',
  strength: 'Хочу стать сильнее и выносливее',
  awareness: 'Хочу лучше чувствовать своё тело',
  general_health: 'Хочу поддерживать форму и здоровье',
} as const);

const surveyRequired = (): HttpError =>
  new HttpError(409, 'SURVEY_REQUIRED', 'Complete the profile survey to view progress.');

const validationError = (code: string, fallbackMessage: string, issues: readonly unknown[]) => {
  const firstIssue = issues[0];
  const message =
    typeof firstIssue === 'object' &&
    firstIssue !== null &&
    'message' in firstIssue &&
    typeof firstIssue.message === 'string'
      ? firstIssue.message
      : fallbackMessage;

  return new HttpError(400, code, message);
};

const goalResponse = (survey: ProgressSurveySnapshot): ProgressGoal => ({
  current_goal: survey.goal,
  goal_label: goalLabels[survey.goal],
  set_at: survey.createdAt.toISOString(),
});

const paramsResponse = (survey: ProgressSurveySnapshot): ProgressParams => ({
  gender: survey.gender,
  age_range: survey.ageRange,
  experience: survey.experience,
  injuries: [...survey.injuries],
  survey_updated_at: survey.updatedAt.toISOString(),
});

const weeklyMetricResponse = (metric: WeeklyMetricSnapshot): WeeklyMetric => ({
  program_week: metric.programWeek,
  energy: metric.energy,
  sleep: metric.sleep,
  mood: metric.mood,
  body_satisfaction: metric.bodySatisfaction,
  note: metric.note,
  created_at: metric.createdAt.toISOString(),
});

const metricsResponse = (
  metrics: readonly WeeklyMetricSnapshot[],
  currentWeek: number,
): ProgressMetrics => {
  const history = [...metrics]
    .sort((left, right) => left.programWeek - right.programWeek)
    .map(weeklyMetricResponse);

  return {
    current_week: currentWeek,
    history,
    pending_survey: !history.some((metric) => metric.program_week === currentWeek),
  };
};

const requiredAchievementDescription = (achievement: AchievementSnapshot): string => {
  const description = achievement.description?.trim();

  if (description === undefined || description.length === 0) {
    throw new Error(`Achievement ${achievement.code} does not have a description.`);
  }

  return description;
};

const unlockedAchievementResponse = (achievement: AchievementSnapshot): UnlockedAchievement => {
  if (achievement.unlockedAt === null) {
    throw new Error(`Achievement ${achievement.code} is not unlocked.`);
  }

  return {
    code: achievement.code,
    title: achievement.title,
    description: requiredAchievementDescription(achievement),
    icon_key: achievement.iconKey,
    unlocked_at: achievement.unlockedAt.toISOString(),
  };
};

const lockedAchievementResponse = (achievement: AchievementSnapshot): LockedAchievement => ({
  code: achievement.code,
  title: achievement.title,
  description: requiredAchievementDescription(achievement),
  icon_key: achievement.iconKey,
  progress: `${Math.min(achievement.currentValue, achievement.ruleValue)}/${achievement.ruleValue}`,
});

const achievementsResponse = (
  achievements: readonly AchievementSnapshot[],
): ProgressAchievements => {
  const unlocked = achievements
    .filter((achievement) => achievement.unlockedAt !== null)
    .map(unlockedAchievementResponse);
  const locked = achievements
    .filter((achievement) => achievement.unlockedAt === null)
    .map(lockedAchievementResponse);

  return {
    unlocked,
    locked,
    total_unlocked: unlocked.length,
    total_available: achievements.length,
  };
};

const statsResponse = (snapshot: ProgressDashboardSnapshot['stats']): ProgressStats => ({
  total_workouts: snapshot.totalWorkouts,
  total_weeks_completed: snapshot.totalWeeksCompleted,
  current_streak: snapshot.currentStreak,
  best_streak: snapshot.bestStreak,
  total_minutes_trained: snapshot.totalMinutesTrained,
});

export class ProgressService {
  public constructor(
    private readonly repository: ProgressRepository,
    private readonly programRepository: ProgramRepository,
  ) {}

  public async getProgress(userId: string): Promise<ProgressResponse> {
    const [dashboard, program] = await Promise.all([
      this.repository.getDashboard(userId),
      this.programRepository.getProgress(userId),
    ]);

    if (dashboard === null) {
      throw surveyRequired();
    }

    return this.progressResponse(dashboard, program);
  }

  public async submitWeeklyMetrics(userId: string, body: unknown): Promise<MetricsResponse> {
    const parsed = weeklyMetricsSchema.safeParse(body);

    if (!parsed.success) {
      throw validationError(
        'INVALID_WEEKLY_METRICS',
        'Weekly metrics are invalid.',
        parsed.error.issues,
      );
    }

    const metric = parsed.data;
    const saved = await this.repository.upsertWeeklyMetrics(userId, {
      programWeek: metric.program_week,
      energy: metric.energy,
      sleep: metric.sleep,
      mood: metric.mood,
      bodySatisfaction: metric.body_satisfaction,
      note: metric.note === undefined || metric.note.length === 0 ? null : metric.note,
    });

    if (!saved) {
      throw new HttpError(404, 'PROFILE_NOT_FOUND', 'The authenticated user was not found.');
    }

    const [metrics, program] = await Promise.all([
      this.repository.getMetrics(userId),
      this.programRepository.getProgress(userId),
    ]);

    if (metrics === null) {
      throw new HttpError(404, 'PROFILE_NOT_FOUND', 'The authenticated user was not found.');
    }

    return metricsResponse(metrics, program.currentWeekNumber);
  }

  public async updateGoal(userId: string, body: unknown): Promise<GoalResponse> {
    const parsed = progressGoalSchema.safeParse(body);

    if (!parsed.success) {
      throw validationError(
        'INVALID_PROGRESS_GOAL',
        'The progress goal is invalid.',
        parsed.error.issues,
      );
    }

    const survey = await this.repository.updateGoalVersion(userId, parsed.data.goal);

    if (survey === null) {
      throw surveyRequired();
    }

    return goalResponse(survey);
  }

  private progressResponse(
    dashboard: ProgressDashboardSnapshot,
    program: ProgramProgressSnapshot,
  ): ProgressResponse {
    return {
      goal: goalResponse(dashboard.survey),
      params: paramsResponse(dashboard.survey),
      metrics: metricsResponse(dashboard.metrics, program.currentWeekNumber),
      achievements: achievementsResponse(dashboard.achievements),
      stats: statsResponse(dashboard.stats),
    };
  }
}
