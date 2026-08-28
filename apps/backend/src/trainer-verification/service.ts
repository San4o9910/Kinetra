import type {
  TrainerVerificationApplicationInput,
  TrainerVerificationListResponse,
  TrainerVerificationMeResponse,
  TrainerVerificationRequestDto,
  TrainerVerificationReviewRequest,
  TrainerVerificationState,
  TrainerVerificationStatus,
} from '@kinetra/shared';

import { HttpError } from '../auth/errors.js';
import type { Clock } from '../auth/service.js';
import type {
  TrainerVerificationApplicationInputRecord,
  TrainerVerificationRepository,
  TrainerVerificationRequestSnapshot,
  TrainerVerificationReviewAction,
  TrainerVerificationReviewResult,
  TrainerVerificationUserMutationResult,
  TrainerVerificationUserSnapshot,
} from './repository.js';
import {
  trainerVerificationApplicationSchema,
  trainerVerificationRequestIdSchema,
  trainerVerificationRequiredReviewSchema,
  trainerVerificationReviewSchema,
  trainerVerificationStatusFilterSchema,
} from './schema.js';

const publicState = (
  request: TrainerVerificationRequestSnapshot | null,
): TrainerVerificationState =>
  request === null || (request.status === 'pending' && request.submittedAt === null)
    ? 'not_started'
    : request.status;

const toRequestDto = (
  request: TrainerVerificationRequestSnapshot,
): TrainerVerificationRequestDto => ({
  id: request.id,
  user_id: request.userId,
  status: publicState(request),
  display_name: request.displayName,
  specialization: request.specialization,
  experience_years: request.experienceYears,
  bio: request.bio,
  city: request.city,
  timezone: request.timezone,
  submitted_at: request.submittedAt?.toISOString() ?? null,
  reviewed_at: request.reviewedAt?.toISOString() ?? null,
  review_reason: request.reviewReason,
  created_at: request.createdAt.toISOString(),
  updated_at: request.updatedAt.toISOString(),
  materials: request.materials.map((material) => ({
    id: material.id,
    kind: material.kind,
    url: material.url,
    title: material.title,
    issued_at: material.issuedAt,
    expires_at: material.expiresAt,
    created_at: material.createdAt.toISOString(),
  })),
});

const toMeResponse = (value: TrainerVerificationUserSnapshot): TrainerVerificationMeResponse => ({
  requested_role: value.requestedRole,
  trainer_verification_state: value.hasActiveTrainerProfile
    ? 'approved'
    : publicState(value.request),
  request: value.request === null ? null : toRequestDto(value.request),
});

const toRepositoryInput = (
  input: TrainerVerificationApplicationInput,
): TrainerVerificationApplicationInputRecord => ({
  displayName: input.display_name,
  specialization: input.specialization,
  experienceYears: input.experience_years,
  bio: input.bio,
  city: input.city,
  timezone: input.timezone,
  materials: input.materials.map((material) => ({
    kind: material.kind,
    url: material.url,
    title: material.title,
    issuedAt: material.issued_at ?? null,
    expiresAt: material.expires_at ?? null,
  })),
});

const firstValidationMessage = (issues: readonly { readonly message: string }[]): string =>
  issues[0]?.message ?? 'Trainer verification input is invalid.';

const applicationFrom = (body: unknown): TrainerVerificationApplicationInputRecord => {
  const parsed = trainerVerificationApplicationSchema.safeParse(body);
  if (!parsed.success) {
    throw new HttpError(
      400,
      'INVALID_TRAINER_APPLICATION',
      firstValidationMessage(parsed.error.issues),
    );
  }
  const input: TrainerVerificationApplicationInput = {
    display_name: parsed.data.display_name,
    specialization: parsed.data.specialization,
    experience_years: parsed.data.experience_years,
    bio: parsed.data.bio,
    city: parsed.data.city,
    timezone: parsed.data.timezone,
    materials: parsed.data.materials.map((material) => ({
      kind: material.kind,
      url: material.url,
      title: material.title,
      ...(material.issued_at === undefined ? {} : { issued_at: material.issued_at }),
      ...(material.expires_at === undefined ? {} : { expires_at: material.expires_at }),
    })),
  };
  return toRepositoryInput(input);
};

const requestIdFrom = (value: string): string => {
  const parsed = trainerVerificationRequestIdSchema.safeParse(value);
  if (!parsed.success) {
    throw new HttpError(400, 'INVALID_REQUEST_ID', 'Trainer verification request ID is invalid.');
  }
  return parsed.data;
};

const reviewFrom = (body: unknown, required: boolean): TrainerVerificationReviewRequest => {
  const parsed = (
    required ? trainerVerificationRequiredReviewSchema : trainerVerificationReviewSchema
  ).safeParse(body ?? {});
  if (!parsed.success) {
    throw new HttpError(400, 'INVALID_REVIEW', firstValidationMessage(parsed.error.issues));
  }
  return parsed.data.reason === undefined ? {} : { reason: parsed.data.reason };
};

const mutationValue = (
  result: TrainerVerificationUserMutationResult,
): TrainerVerificationMeResponse => {
  if (result.status === 'ok') return toMeResponse(result.value);

  switch (result.status) {
    case 'user_not_found':
      throw new HttpError(404, 'PROFILE_NOT_FOUND', 'The authenticated user was not found.');
    case 'role_not_trainer':
      throw new HttpError(
        409,
        'TRAINER_ROLE_NOT_REQUESTED',
        'Trainer verification is available only to users who requested the trainer role.',
      );
    case 'request_not_found':
      throw new HttpError(
        404,
        'TRAINER_APPLICATION_NOT_FOUND',
        'Trainer application was not found.',
      );
    case 'invalid_state':
      throw new HttpError(
        409,
        'TRAINER_APPLICATION_STATE_CONFLICT',
        'Trainer application cannot be changed in its current state.',
      );
    case 'conflict':
      throw new HttpError(
        409,
        'TRAINER_APPLICATION_CONFLICT',
        'Another active trainer application already exists.',
      );
  }
};

const reviewedValue = (result: TrainerVerificationReviewResult): TrainerVerificationRequestDto => {
  if (result.status === 'ok') return toRequestDto(result.request);

  switch (result.status) {
    case 'not_reviewer':
      throw new HttpError(403, 'REVIEWER_ACCESS_REQUIRED', 'Reviewer access is required.');
    case 'request_not_found':
      throw new HttpError(
        404,
        'TRAINER_APPLICATION_NOT_FOUND',
        'Trainer application was not found.',
      );
    case 'self_review':
      throw new HttpError(
        403,
        'SELF_REVIEW_FORBIDDEN',
        'Reviewers cannot review their own application.',
      );
    case 'not_submitted':
      throw new HttpError(
        409,
        'TRAINER_APPLICATION_NOT_SUBMITTED',
        'Application has not been submitted.',
      );
    case 'email_not_verified':
      throw new HttpError(
        403,
        'EMAIL_NOT_VERIFIED',
        'Email verification is required before trainer approval.',
      );
    case 'invalid_state':
      throw new HttpError(
        409,
        'TRAINER_APPLICATION_STATE_CONFLICT',
        'Trainer application cannot be reviewed in its current state.',
      );
    case 'client_chat_history':
      throw new HttpError(
        409,
        'CLIENT_CHAT_HISTORY_REQUIRES_RESOLUTION',
        'Existing client chat history must be resolved before trainer approval.',
      );
  }
};

export class TrainerVerificationService {
  public constructor(
    private readonly repository: TrainerVerificationRepository,
    private readonly clock: Clock,
  ) {}

  public async getMe(userId: string): Promise<TrainerVerificationMeResponse> {
    const value = await this.repository.findForUser(userId);
    if (value === null) {
      throw new HttpError(404, 'PROFILE_NOT_FOUND', 'The authenticated user was not found.');
    }
    return toMeResponse(value);
  }

  public async submit(userId: string, body: unknown): Promise<TrainerVerificationMeResponse> {
    return mutationValue(
      await this.repository.submit(userId, applicationFrom(body), this.clock.now()),
    );
  }

  public async update(userId: string, body: unknown): Promise<TrainerVerificationMeResponse> {
    return mutationValue(
      await this.repository.update(userId, applicationFrom(body), this.clock.now()),
    );
  }

  public async withdraw(userId: string, body: unknown): Promise<TrainerVerificationMeResponse> {
    if (
      typeof (body ?? {}) !== 'object' ||
      body === null ||
      Array.isArray(body) ||
      Object.keys(body ?? {}).length !== 0
    ) {
      throw new HttpError(
        400,
        'INVALID_REQUEST_BODY',
        'Request body must be an empty JSON object.',
      );
    }
    return mutationValue(await this.repository.withdraw(userId, this.clock.now()));
  }

  public async list(
    reviewerUserId: string,
    rawStatus: unknown,
  ): Promise<TrainerVerificationListResponse> {
    let status: TrainerVerificationStatus | null = null;
    if (rawStatus !== undefined) {
      const parsed = trainerVerificationStatusFilterSchema.safeParse(rawStatus);
      if (!parsed.success) {
        throw new HttpError(400, 'INVALID_STATUS_FILTER', 'Trainer application status is invalid.');
      }
      status = parsed.data;
    }

    const result = await this.repository.listForReviewer(reviewerUserId, status);
    if (result.status === 'not_reviewer') {
      throw new HttpError(403, 'REVIEWER_ACCESS_REQUIRED', 'Reviewer access is required.');
    }
    return { requests: result.requests.map(toRequestDto) };
  }

  public async approve(
    reviewerUserId: string,
    rawRequestId: string,
    body: unknown,
  ): Promise<TrainerVerificationRequestDto> {
    return this.review(reviewerUserId, rawRequestId, 'approve', body, false);
  }

  public async requestInfo(
    reviewerUserId: string,
    rawRequestId: string,
    body: unknown,
  ): Promise<TrainerVerificationRequestDto> {
    return this.review(reviewerUserId, rawRequestId, 'request_info', body, true);
  }

  public async reject(
    reviewerUserId: string,
    rawRequestId: string,
    body: unknown,
  ): Promise<TrainerVerificationRequestDto> {
    return this.review(reviewerUserId, rawRequestId, 'reject', body, true);
  }

  private async review(
    reviewerUserId: string,
    rawRequestId: string,
    action: TrainerVerificationReviewAction,
    body: unknown,
    reasonRequired: boolean,
  ): Promise<TrainerVerificationRequestDto> {
    const requestId = requestIdFrom(rawRequestId);
    const review = reviewFrom(body, reasonRequired);
    return reviewedValue(
      await this.repository.review(
        reviewerUserId,
        requestId,
        action,
        review.reason ?? null,
        this.clock.now(),
      ),
    );
  }
}
