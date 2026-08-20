export interface UserRecord {
  readonly id: string;
  readonly email: string | null;
  readonly phone: string | null;
  readonly passwordHash: string;
  readonly emailVerified: boolean;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

export interface CreateUserInput {
  readonly id: string;
  readonly email: string | null;
  readonly phone: string | null;
  readonly passwordHash: string;
  readonly emailVerified: boolean;
  readonly now: Date;
}

export type CreateUserResult =
  | { readonly status: 'created'; readonly user: UserRecord }
  | { readonly status: 'conflict'; readonly field: 'email' | 'phone' };

export interface RefreshSessionInput {
  readonly id: string;
  readonly userId: string;
  readonly tokenHash: string;
  readonly expiresAt: Date;
  readonly now: Date;
}

export interface ReplacementRefreshSessionInput {
  readonly id: string;
  readonly tokenHash: string;
  readonly expiresAt: Date;
  readonly now: Date;
}

export interface RotateRefreshSessionInput {
  readonly currentTokenHash: string;
  readonly replacement: ReplacementRefreshSessionInput;
  readonly now: Date;
}

export type RotateRefreshSessionResult =
  | { readonly status: 'rotated'; readonly user: UserRecord }
  | { readonly status: 'invalid' }
  | { readonly status: 'reused' };

export interface OneTimeTokenInput {
  readonly id: string;
  readonly userId: string;
  readonly tokenHash: string;
  readonly expiresAt: Date;
  readonly now: Date;
}

export interface AuthRepository {
  findUserByEmail(email: string): Promise<UserRecord | null>;
  findUserByPhone(phone: string): Promise<UserRecord | null>;
  createUser(input: CreateUserInput): Promise<CreateUserResult>;
  createRefreshSession(input: RefreshSessionInput): Promise<void>;
  rotateRefreshSession(input: RotateRefreshSessionInput): Promise<RotateRefreshSessionResult>;
  revokeRefreshSessionByHash(tokenHash: string, now: Date): Promise<void>;
  revokeAllRefreshSessions(userId: string, now: Date): Promise<void>;
  storePasswordResetToken(input: OneTimeTokenInput): Promise<void>;
  replacePasswordUsingResetToken(
    tokenHash: string,
    newPasswordHash: string,
    now: Date,
  ): Promise<UserRecord | null>;
  storeEmailVerificationToken(input: OneTimeTokenInput): Promise<void>;
  verifyEmailUsingToken(tokenHash: string, now: Date): Promise<UserRecord | null>;
}
