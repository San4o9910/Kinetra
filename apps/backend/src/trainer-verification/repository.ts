import type {
  RequestedRole,
  TrainerVerificationMaterialKind,
  TrainerVerificationStatus,
} from '@kinetra/shared';

export interface TrainerVerificationMaterialInput {
  readonly kind: TrainerVerificationMaterialKind;
  readonly url: string;
  readonly title: string;
  readonly issuedAt: string | null;
  readonly expiresAt: string | null;
}

export interface TrainerVerificationApplicationInputRecord {
  readonly displayName: string;
  readonly specialization: string;
  readonly experienceYears: number;
  readonly bio: string;
  readonly city: string | null;
  readonly timezone: string;
  readonly materials: readonly TrainerVerificationMaterialInput[];
}

export interface TrainerVerificationMaterialSnapshot {
  readonly id: string;
  readonly kind: TrainerVerificationMaterialKind;
  readonly url: string;
  readonly title: string;
  readonly issuedAt: string | null;
  readonly expiresAt: string | null;
  readonly createdAt: Date;
}

export interface TrainerVerificationRequestSnapshot {
  readonly id: string;
  readonly userId: string;
  readonly status: TrainerVerificationStatus;
  readonly displayName: string | null;
  readonly specialization: string | null;
  readonly experienceYears: number | null;
  readonly bio: string | null;
  readonly city: string | null;
  readonly timezone: string | null;
  readonly submittedAt: Date | null;
  readonly reviewedAt: Date | null;
  readonly reviewerUserId: string | null;
  readonly reviewReason: string | null;
  readonly createdAt: Date;
  readonly updatedAt: Date;
  readonly materials: readonly TrainerVerificationMaterialSnapshot[];
}

export interface TrainerVerificationUserSnapshot {
  readonly requestedRole: RequestedRole;
  readonly hasActiveTrainerProfile: boolean;
  readonly request: TrainerVerificationRequestSnapshot | null;
}

export type TrainerVerificationUserMutationResult =
  | { readonly status: 'ok'; readonly value: TrainerVerificationUserSnapshot }
  | {
      readonly status:
        'user_not_found' | 'role_not_trainer' | 'request_not_found' | 'invalid_state' | 'conflict';
    };

export type TrainerVerificationListResult =
  | { readonly status: 'ok'; readonly requests: readonly TrainerVerificationRequestSnapshot[] }
  | { readonly status: 'not_reviewer' };

export type TrainerVerificationReviewAction = 'approve' | 'request_info' | 'reject';

export type TrainerVerificationReviewResult =
  | { readonly status: 'ok'; readonly request: TrainerVerificationRequestSnapshot }
  | {
      readonly status:
        | 'not_reviewer'
        | 'request_not_found'
        | 'self_review'
        | 'not_submitted'
        | 'email_not_verified'
        | 'invalid_state'
        | 'client_chat_history';
    };

export type ReviewerMutationResult = 'updated' | 'user_not_found';

export interface TrainerVerificationRepository {
  findForUser(userId: string): Promise<TrainerVerificationUserSnapshot | null>;
  submit(
    userId: string,
    input: TrainerVerificationApplicationInputRecord,
    now: Date,
  ): Promise<TrainerVerificationUserMutationResult>;
  update(
    userId: string,
    input: TrainerVerificationApplicationInputRecord,
    now: Date,
  ): Promise<TrainerVerificationUserMutationResult>;
  withdraw(userId: string, now: Date): Promise<TrainerVerificationUserMutationResult>;
  listForReviewer(
    reviewerUserId: string,
    status: TrainerVerificationStatus | null,
  ): Promise<TrainerVerificationListResult>;
  review(
    reviewerUserId: string,
    requestId: string,
    action: TrainerVerificationReviewAction,
    reason: string | null,
    now: Date,
  ): Promise<TrainerVerificationReviewResult>;
  grantReviewer(userId: string, now: Date): Promise<ReviewerMutationResult>;
  revokeReviewer(userId: string): Promise<ReviewerMutationResult>;
}
