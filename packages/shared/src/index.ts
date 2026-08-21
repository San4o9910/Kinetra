export interface HealthResponse {
  readonly status: 'ok';
  readonly service: 'kinetra-backend';
  readonly version: string;
  readonly timestamp: string;
}

export interface ApiErrorResponse {
  readonly error: {
    readonly code: string;
    readonly message: string;
    readonly requestId?: string;
  };
}

export interface PublicUser {
  readonly id: string;
  readonly email: string | null;
  readonly phone: string | null;
  readonly emailVerified: boolean;
  readonly createdAt: string;
}

export interface AuthSessionResponse {
  readonly user: PublicUser;
  readonly accessToken: string;
  readonly tokenType: 'Bearer';
  readonly expiresIn: number;
}

export interface RegistrationPendingVerificationResponse {
  readonly user: PublicUser;
  readonly emailVerificationRequired: true;
}

export type RegisterResponse = AuthSessionResponse | RegistrationPendingVerificationResponse;

export interface RegisterRequest {
  readonly email?: string;
  readonly phone?: string;
  readonly password: string;
}

export interface LoginRequest {
  readonly identifier?: string;
  readonly email?: string;
  readonly phone?: string;
  readonly password: string;
}

export interface PasswordResetRequest {
  readonly identifier?: string;
  readonly email?: string;
  readonly phone?: string;
}

export interface PasswordResetConfirmRequest {
  readonly token: string;
  readonly newPassword: string;
}

export interface VerifyEmailRequest {
  readonly token: string;
}

export interface MessageResponse {
  readonly message: string;
}

export type OnboardingStatus = 'survey_pending' | 'onboarding_pending' | 'base_lessons' | 'active';

export type SurveyGender = 'male' | 'female';
export type SurveyAgeRange = '18-25' | '26-35' | '36-45' | '46-55' | '55+';
export type SurveyGoal = 'flexibility' | 'strength' | 'awareness' | 'general_health';
export type SurveyInjury = 'none' | 'knees' | 'lower_back' | 'shoulders' | 'neck' | 'other';
export type SurveyExperience = 'beginner' | 'novice' | 'experienced';

export interface SurveySubmission {
  readonly gender: SurveyGender;
  readonly age_range: SurveyAgeRange;
  readonly goal: SurveyGoal;
  readonly injuries: readonly SurveyInjury[];
  readonly injuries_detail?: string;
  readonly experience: SurveyExperience;
}

export interface SurveyAnswer {
  readonly id: string;
  readonly version: number;
  readonly gender: SurveyGender;
  readonly age_range: SurveyAgeRange;
  readonly goal: SurveyGoal;
  readonly injuries: readonly SurveyInjury[];
  readonly injuries_detail: string | null;
  readonly experience: SurveyExperience;
  readonly is_current: boolean;
  readonly created_at: string;
}

export type SubscriptionProvider = 'yukassa' | 'tribute';
export type SubscriptionStatus = 'pending' | 'active' | 'expired' | 'cancelled' | 'refunded';
export type ProfileSubscriptionStatus = SubscriptionStatus | 'none';

export interface ProfileUser {
  readonly id: string;
  readonly email: string | null;
  readonly phone: string | null;
  readonly emailVerified: boolean;
  readonly avatarUrl: string | null;
  readonly username: string | null;
  readonly firstName: string | null;
  readonly onboardingStatus: OnboardingStatus;
  readonly notificationEnabled: boolean;
  readonly level: 'beginner' | 'intermediate' | 'advanced';
  readonly timezone: string;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface ProfileSubscription {
  readonly provider: SubscriptionProvider | null;
  readonly status: ProfileSubscriptionStatus;
  readonly isActive: boolean;
  readonly startsAt: string | null;
  readonly expiresAt: string | null;
  readonly amountMinor: number | null;
  readonly currency: string | null;
}

export interface MeResponse {
  readonly user: ProfileUser;
  readonly survey: SurveyAnswer | null;
  readonly subscription: ProfileSubscription;
}

export interface BaseLessonProgress {
  readonly completion_percent: number;
  readonly completed: boolean;
}

export interface BaseLesson {
  readonly id: string;
  readonly slug: string;
  readonly title: string;
  readonly description: string | null;
  readonly duration_seconds: number;
  readonly order_index: number;
  readonly poster_url: string | null;
  readonly video_url: string | null;
  readonly progress: BaseLessonProgress;
}

export interface BaseLessonsResponse {
  readonly lessons: readonly BaseLesson[];
  readonly total_completed: number;
  readonly unlock_threshold: number;
  readonly program_unlocked: boolean;
}

export interface UpdateLessonProgressRequest {
  readonly position_seconds: number;
  readonly completion_percent: number;
}

export interface LessonProgressResponse {
  readonly position_seconds: number;
  readonly completion_percent: number;
  readonly completed: boolean;
  readonly completed_at: string | null;
}

export type ProgramDirection =
  'breathing' | 'strength' | 'body_therapy' | 'functional' | 'stretching' | 'neuro' | 'recovery';

export type ProgramWeekStatus = 'locked' | 'active' | 'completed';

export interface ProgramVideo {
  readonly id: string;
  readonly video_url: string | null;
  readonly poster_url: string | null;
}

export interface ProgramDay {
  readonly id: string;
  readonly day_of_week: number;
  readonly direction: ProgramDirection;
  readonly title: string;
  readonly description: string | null;
  readonly duration_minutes: number;
  readonly icon: string;
  readonly video: ProgramVideo;
  readonly completed: boolean;
  readonly completed_at: string | null;
}

export interface ProgramWeek {
  readonly id: string;
  readonly week_number: number;
  readonly title: string;
  readonly status: ProgramWeekStatus;
  readonly days: readonly ProgramDay[];
  readonly days_completed: number;
  readonly total_days: number;
}

export interface ProgramOverallProgress {
  readonly weeks_completed: number;
  readonly total_workouts_done: number;
}

export interface WeekResponse {
  readonly week: ProgramWeek;
  readonly total_weeks: number;
  readonly overall_progress: ProgramOverallProgress;
}

export type ProgramDayLabel =
  'Понедельник' | 'Вторник' | 'Среда' | 'Четверг' | 'Пятница' | 'Суббота' | 'Воскресенье';

export interface ProgramScheduleDay {
  readonly day_of_week: number;
  readonly day_label: ProgramDayLabel;
  readonly direction: ProgramDirection;
  readonly icon: string;
  readonly title: string;
  readonly description: string;
  readonly duration_minutes: number;
  readonly completed: boolean;
}

export interface ProgramScheduleWeek {
  readonly week_number: number;
  readonly title: string;
  readonly days: readonly ProgramScheduleDay[];
  readonly days_completed: number;
  readonly total_days: number;
}

export interface ScheduleResponse {
  readonly current_week: ProgramScheduleWeek;
  readonly next_week: ProgramScheduleWeek | null;
}

export interface ProgressGoal {
  readonly current_goal: SurveyGoal;
  readonly goal_label: string;
  readonly set_at: string;
}

export interface ProgressParams {
  readonly gender: SurveyGender;
  readonly age_range: SurveyAgeRange;
  readonly experience: SurveyExperience;
  readonly injuries: readonly SurveyInjury[];
  readonly survey_updated_at: string;
}

export interface WeeklyMetric {
  readonly program_week: number;
  readonly energy: number;
  readonly sleep: number;
  readonly mood: number;
  readonly body_satisfaction: number;
  readonly note: string | null;
  readonly created_at: string;
}

export interface ProgressMetrics {
  readonly current_week: number;
  readonly history: readonly WeeklyMetric[];
  readonly pending_survey: boolean;
}

export interface UnlockedAchievement {
  readonly code: string;
  readonly title: string;
  readonly description: string;
  readonly icon_key: string;
  readonly unlocked_at: string;
}

export interface LockedAchievement {
  readonly code: string;
  readonly title: string;
  readonly description: string;
  readonly icon_key: string;
  readonly progress: string;
}

export interface ProgressAchievements {
  readonly unlocked: readonly UnlockedAchievement[];
  readonly locked: readonly LockedAchievement[];
  readonly total_unlocked: number;
  readonly total_available: number;
}

export interface ProgressStats {
  readonly total_workouts: number;
  readonly total_weeks_completed: number;
  readonly current_streak: number;
  readonly best_streak: number;
  readonly total_minutes_trained: number;
}

export interface ProgressResponse {
  readonly goal: ProgressGoal;
  readonly params: ProgressParams;
  readonly metrics: ProgressMetrics;
  readonly achievements: ProgressAchievements;
  readonly stats: ProgressStats;
}

export interface WeeklyMetricsInput {
  readonly program_week: number;
  readonly energy: number;
  readonly sleep: number;
  readonly mood: number;
  readonly body_satisfaction: number;
  readonly note?: string;
}

export type MetricsResponse = ProgressMetrics;
export type GoalResponse = ProgressGoal;

export type SettingsSubscriptionStatus = 'active' | 'expired' | 'cancelled' | 'pending' | 'none';

export interface SubscriptionResponse {
  readonly status: SettingsSubscriptionStatus;
  readonly provider: SubscriptionProvider | null;
  readonly starts_at: string | null;
  readonly expires_at: string | null;
  readonly amount: number | null;
  readonly currency: string | null;
  readonly auto_renew: boolean | null;
  readonly days_remaining: number | null;
}

export interface NotificationPreferences {
  readonly workout_reminders: boolean;
  readonly reminder_time: string;
  readonly weekly_survey_reminder: boolean;
}

export interface SettingsProfileResponse {
  readonly email: string | null;
  readonly phone: string | null;
  readonly created_at: string;
  readonly onboarding_status: OnboardingStatus;
  readonly notification_preferences: NotificationPreferences;
}

export interface DeleteAccountRequest {
  readonly confirm: 'DELETE';
}

export interface CompleteWorkoutRequest {
  readonly video_id: string;
  readonly program_week: number;
}
