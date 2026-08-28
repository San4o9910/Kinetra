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
  readonly requested_role: RequestedRole;
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
export type AccountRole = 'client' | 'trainer';
export type RequestedRole = 'trainer' | 'trainee';
export type TrainerVerificationStatus =
  'pending' | 'needs_more_info' | 'approved' | 'rejected' | 'withdrawn';
export type TrainerVerificationState = 'not_started' | TrainerVerificationStatus;
export type TrainerVerificationMaterialKind =
  'professional_profile' | 'certificate' | 'diploma' | 'portfolio' | 'other';

export interface TrainerVerificationApplicationInput {
  readonly display_name: string;
  readonly specialization: string;
  readonly experience_years: number;
  readonly bio: string;
  readonly city: string;
  readonly timezone: string;
  readonly materials: readonly {
    readonly kind: TrainerVerificationMaterialKind;
    readonly url: string;
    readonly title: string;
    readonly issued_at?: string;
    readonly expires_at?: string;
  }[];
}

export interface TrainerVerificationMaterialDto {
  readonly id: string;
  readonly kind: TrainerVerificationMaterialKind;
  readonly url: string;
  readonly title: string;
  readonly issued_at: string | null;
  readonly expires_at: string | null;
  readonly created_at: string;
}

export interface TrainerVerificationRequestDto {
  readonly id: string;
  readonly user_id: string;
  readonly status: TrainerVerificationState;
  readonly display_name: string | null;
  readonly specialization: string | null;
  readonly experience_years: number | null;
  readonly bio: string | null;
  readonly city: string | null;
  readonly timezone: string | null;
  readonly submitted_at: string | null;
  readonly reviewed_at: string | null;
  readonly review_reason: string | null;
  readonly created_at: string;
  readonly updated_at: string;
  readonly materials: readonly TrainerVerificationMaterialDto[];
}

export interface TrainerVerificationMeResponse {
  readonly requested_role: RequestedRole;
  readonly trainer_verification_state: TrainerVerificationState;
  readonly request: TrainerVerificationRequestDto | null;
}

export interface TrainerVerificationListResponse {
  readonly requests: readonly TrainerVerificationRequestDto[];
}

export interface TrainerVerificationReviewRequest {
  readonly reason?: string;
}

export interface TrainerProfile {
  readonly display_name: string;
  readonly avatar_url: string | null;
  readonly can_manage_videos: boolean;
}

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
  readonly account_role: AccountRole;
  readonly trainer_profile: TrainerProfile | null;
  readonly requested_role?: RequestedRole;
  readonly trainer_verification_state?: TrainerVerificationState;
  readonly user: ProfileUser;
  readonly survey: SurveyAnswer | null;
  readonly subscription: ProfileSubscription;
}

export interface RegistrationAwareMeResponse extends MeResponse {
  readonly requested_role: RequestedRole;
  readonly trainer_verification_state: TrainerVerificationState;
}

export type TrainerVideoUploadStatus =
  | 'creating'
  | 'uploading'
  | 'completing'
  | 'verification_pending'
  | 'verifying'
  | 'verification_quarantined'
  | 'published'
  | 'failed'
  | 'cancelled'
  | 'expired'
  | 'superseded';

export type TrainerVideoSlotState =
  'empty' | 'uploading' | 'processing' | 'available' | 'replacing' | 'failed' | 'hidden';

export interface TrainerVerifiedMediaDto {
  readonly duration_seconds: number;
  readonly width: number;
  readonly height: number;
  readonly video_codec: string;
  readonly audio_codec: string | null;
  readonly sha256: string;
}

export interface TrainerVideoUploadDto {
  readonly id: string;
  readonly video_id: string;
  readonly week_number: number;
  readonly day_of_week: number;
  readonly status: TrainerVideoUploadStatus;
  readonly expected_size_bytes: number;
  readonly uploaded_bytes: number;
  readonly part_size_bytes: number;
  readonly part_count: number;
  readonly expires_at: string;
  readonly failure_code: string | null;
  readonly verified_media: TrainerVerifiedMediaDto | null;
}

export interface TrainerVideoSlotDto {
  readonly video_id: string;
  readonly day_of_week: number;
  readonly day_label: string;
  readonly direction: ProgramDirection;
  readonly title: string;
  readonly duration_minutes: number;
  readonly media: {
    readonly available: boolean;
    readonly revision: number;
    readonly duration_seconds: number | null;
    readonly uploaded_at: string | null;
  };
  readonly slot_state: TrainerVideoSlotState;
  readonly live_upload: TrainerVideoUploadDto | null;
  readonly latest_upload: TrainerVideoUploadDto | null;
}

export interface TrainerVideoProgramResponse {
  readonly summary: {
    readonly total: 84;
    readonly available: number;
    readonly processing: number;
    readonly failed: number;
  };
  readonly weeks: readonly {
    readonly week_number: number;
    readonly title: string;
    readonly days: readonly TrainerVideoSlotDto[];
  }[];
}

export interface TrainerVideoPartRequest {
  readonly part_number: number;
  readonly checksum_sha256: string;
}

export interface TrainerVideoPartUrlDto {
  readonly part_number: number;
  readonly upload_url: string;
  readonly expires_at: string;
  readonly required_headers: Readonly<Record<'x-amz-checksum-sha256', string>>;
}

export interface TrainerVideoAcceptedPartDto {
  readonly part_number: number;
  readonly size_bytes: number;
  readonly checksum_sha256: string;
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

export interface CreatePaymentRequest {
  readonly return_url: string;
}

export interface CreatePaymentResponse {
  readonly payment_id: string;
  readonly confirmation_url: string;
  readonly status: 'pending';
}

export interface NotificationPreferences {
  readonly workout_reminders: boolean;
  readonly reminder_time: string;
  readonly weekly_survey_reminder: boolean;
}

export interface PushPublicKeyResponse {
  readonly public_key: string;
}

export interface PushSubscriptionRequest {
  readonly endpoint: string;
  readonly keys: {
    readonly p256dh: string;
    readonly auth: string;
  };
  readonly expirationTime: number | null;
}

export interface PushSubscriptionResponse {
  readonly subscribed: true;
}

export interface PushUnsubscribeRequest {
  readonly endpoint: string;
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

export type ChatRole = AccountRole;
export type ChatMessageKind = 'text' | 'photo';
export type ChatPhotoStatus = 'processing' | 'ready' | 'attached' | 'failed';

export interface CanonicalChatTextValue {
  readonly value: string;
  readonly codePointLength: number;
  readonly hasForbiddenControl: boolean;
}

const chatBoundaryWhitespacePattern = /^\p{White_Space}+|\p{White_Space}+$/gu;
const isForbiddenChatControl = (character: string): boolean => {
  const codePoint = character.codePointAt(0);
  return (
    codePoint !== undefined &&
    ((codePoint >= 0 && codePoint <= 8) ||
      (codePoint >= 11 && codePoint <= 31) ||
      codePoint === 127)
  );
};

export const canonicalizeChatTextValue = (rawValue: string): CanonicalChatTextValue => {
  const value = rawValue
    .replace(/\r\n?/gu, '\n')
    .normalize('NFC')
    .replace(chatBoundaryWhitespacePattern, '');

  const codePoints = Array.from(value);

  return {
    value,
    codePointLength: codePoints.length,
    hasForbiddenControl: codePoints.some(isForbiddenChatControl),
  };
};

export interface ChatCounterpartProfile {
  readonly display_name: string;
  readonly avatar_url: string | null;
}

export interface ChatPhotoDto {
  readonly id: string;
  readonly status: ChatPhotoStatus;
  readonly mime_type: 'image/webp';
  readonly width: number;
  readonly height: number;
  readonly size_bytes: number;
  readonly expires_at: string | null;
  readonly failure_code?: string;
  readonly retry_allowed?: boolean;
}

export interface ChatMessageDto {
  readonly id: string;
  readonly conversation_id: string;
  readonly sequence: number;
  readonly client_message_id: string;
  readonly sender_role: ChatRole;
  readonly is_mine: boolean;
  readonly sender_name: string;
  readonly kind: ChatMessageKind;
  readonly text: string | null;
  readonly photo: ChatPhotoDto | null;
  readonly created_at: string;
}

export interface ChatConversationStateDto {
  readonly last_message_sequence: number;
  readonly own_last_read_sequence: number;
  readonly counterpart_last_read_sequence: number;
  readonly unread_count: number;
}

export interface ChatClientConversationDto {
  readonly id: string;
  readonly trainer: ChatCounterpartProfile;
  readonly last_message_sequence: number;
  readonly last_read_sequence: number;
  readonly counterpart_last_read_sequence: number;
  readonly unread_count: number;
}

export interface ChatClientSessionResponse {
  readonly role: 'client';
  readonly enabled: boolean;
  readonly photo_uploads_enabled: boolean;
  readonly available: boolean;
  readonly conversation: ChatClientConversationDto | null;
}

export interface ChatTrainerSessionResponse {
  readonly role: 'trainer';
  readonly enabled: boolean;
  readonly photo_uploads_enabled: boolean;
  readonly profile: TrainerProfile;
  readonly unread_count: number;
}

export type ChatSessionResponse = ChatClientSessionResponse | ChatTrainerSessionResponse;

export interface ChatConversationResponse {
  readonly conversation: ChatClientConversationDto;
}

export interface ChatClientInboxProfile {
  readonly display_name: string;
  readonly secondary_label: string;
  readonly avatar_url: string | null;
}

export interface ChatLastMessageSummary {
  readonly kind: ChatMessageKind;
  readonly preview: string;
  readonly created_at: string;
}

export interface ChatConversationSummaryDto {
  readonly id: string;
  readonly client: ChatClientInboxProfile;
  readonly last_message: ChatLastMessageSummary | null;
  readonly unread_count: number;
  readonly activity_at: string;
}

export interface ChatConversationSummaryResponse {
  readonly conversation: ChatConversationSummaryDto;
}

export interface ChatConversationListResponse {
  readonly items: readonly ChatConversationSummaryDto[];
  readonly next_cursor: string | null;
}

export interface ChatMessagePageResponse {
  readonly messages: readonly ChatMessageDto[];
  readonly conversation_state: ChatConversationStateDto;
  readonly next_before_sequence: number | null;
  readonly has_more_before: boolean;
  readonly next_after_sequence: number | null;
  readonly has_more_after: boolean;
}

export interface ChatTextMessageRequest {
  readonly client_message_id: string;
  readonly kind: 'text';
  readonly text: string;
}

export interface ChatPhotoMessageRequest {
  readonly client_message_id: string;
  readonly kind: 'photo';
  readonly text?: string | null;
  readonly photo_id: string;
}

export type ChatSendMessageRequest = ChatTextMessageRequest | ChatPhotoMessageRequest;

export interface ChatSendMessageResponse {
  readonly message: ChatMessageDto;
  readonly conversation_state: ChatConversationStateDto;
  readonly replayed: boolean;
}

export interface ChatReadRequest {
  readonly through_sequence: number;
}

export interface ChatReadResponse {
  readonly conversation_state: ChatConversationStateDto;
}

export interface ChatPhotoResponse {
  readonly photo: ChatPhotoDto;
}

export interface ChatPhotoAccessResponse {
  readonly url: string;
  readonly expires_at: string;
}

export interface ChatMessageNewEvent {
  readonly message: ChatMessageDto;
}

export interface ChatConversationUpdatedEvent {
  readonly conversation_id: string;
  readonly last_message: ChatLastMessageSummary | null;
  readonly unread_count: number;
}

export interface ChatReadUpdatedEvent {
  readonly conversation_id: string;
  readonly reader_role: ChatRole;
  readonly through_sequence: number;
  readonly read_at: string;
}

export interface ChatSessionInvalidatedEvent {
  readonly reason: 'session_inactive' | 'account_changed' | 'token_expired';
}

export interface ChatServerToClientEvents {
  'chat:message:new': (event: ChatMessageNewEvent) => void;
  'chat:conversation:updated': (event: ChatConversationUpdatedEvent) => void;
  'chat:read:updated': (event: ChatReadUpdatedEvent) => void;
  'chat:session:invalidated': (event: ChatSessionInvalidatedEvent) => void;
}

export interface ChatClientToServerEvents {
  'chat:sync': (
    event: { readonly conversation_id: string; readonly last_sequence: number },
    acknowledge: (response: { readonly delta_required: boolean }) => void,
  ) => void;
}
