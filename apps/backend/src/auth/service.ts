import type {
  AuthSessionResponse,
  PublicUser,
  RegistrationPendingVerificationResponse,
} from '@kinetra/shared';
import { randomUUID } from 'node:crypto';

import type { AuthTokenDelivery } from './delivery.js';
import { HttpError } from './errors.js';
import {
  normalizeEmail,
  normalizeIdentifier,
  normalizePhone,
  type NormalizedIdentifier,
} from './normalization.js';
import type { PasswordHasher } from './password.js';
import { validatePassword } from './password.js';
import type { AuthRepository, UserRecord } from './repository.js';
import {
  hashOpaqueToken,
  isPlausibleOpaqueToken,
  type HmacJwtAccessTokenService,
  type OpaqueTokenService,
} from './tokens.js';

const DUMMY_BCRYPT_HASH = '$2b$12$IYjJqhf.jrYW.sbFLsYkfOUjuwyYvLLYFeRyME0I8v2Kz7JKeLKSy';

export const PASSWORD_RESET_REQUEST_MESSAGE =
  'If the account exists, password-reset instructions have been sent.';

export interface Clock {
  now(): Date;
}

export class SystemClock implements Clock {
  public now(): Date {
    return new Date();
  }
}

export interface AuthServiceConfig {
  readonly phoneLoginEnabled: boolean;
  readonly phoneOnlyRegistrationEnabled: boolean;
  readonly emailVerificationRequired: boolean;
  readonly passwordMinimumLength: number;
  readonly refreshTtlMs: number;
  readonly passwordResetTtlMs: number;
  readonly emailVerificationTtlMs: number;
}

export interface AuthServiceDependencies {
  readonly repository: AuthRepository;
  readonly passwordHasher: PasswordHasher;
  readonly opaqueTokens: OpaqueTokenService;
  readonly accessTokens: HmacJwtAccessTokenService;
  readonly tokenDelivery: AuthTokenDelivery;
  readonly clock: Clock;
  readonly config: AuthServiceConfig;
}

export interface RegisterInput {
  readonly email?: string;
  readonly phone?: string;
  readonly password: string;
}

export interface LoginInput {
  readonly identifier: string;
  readonly password: string;
}

export interface AuthenticatedSession {
  readonly response: AuthSessionResponse;
  readonly refreshToken: string;
}

export type RegisterResult =
  | { readonly kind: 'authenticated'; readonly session: AuthenticatedSession }
  | {
      readonly kind: 'verification-required';
      readonly response: RegistrationPendingVerificationResponse;
    };

const toPublicUser = (user: UserRecord): PublicUser => ({
  id: user.id,
  email: user.email,
  phone: user.phone,
  emailVerified: user.emailVerified,
  createdAt: user.createdAt.toISOString(),
});

const addMilliseconds = (date: Date, milliseconds: number): Date =>
  new Date(date.getTime() + milliseconds);

export class AuthService {
  private readonly repository: AuthRepository;
  private readonly passwordHasher: PasswordHasher;
  private readonly opaqueTokens: OpaqueTokenService;
  private readonly accessTokens: HmacJwtAccessTokenService;
  private readonly tokenDelivery: AuthTokenDelivery;
  private readonly clock: Clock;
  private readonly config: AuthServiceConfig;

  public constructor(dependencies: AuthServiceDependencies) {
    this.repository = dependencies.repository;
    this.passwordHasher = dependencies.passwordHasher;
    this.opaqueTokens = dependencies.opaqueTokens;
    this.accessTokens = dependencies.accessTokens;
    this.tokenDelivery = dependencies.tokenDelivery;
    this.clock = dependencies.clock;
    this.config = dependencies.config;
  }

  public get emailVerificationEnabled(): boolean {
    return this.config.emailVerificationRequired;
  }

  public async register(input: RegisterInput): Promise<RegisterResult> {
    const email = this.normalizeRegistrationEmail(input.email);
    const phone = this.normalizeRegistrationPhone(input.phone);

    if (email === null && phone === null) {
      throw new HttpError(400, 'IDENTIFIER_REQUIRED', 'Email or phone is required.');
    }

    if (email === null && !this.config.phoneOnlyRegistrationEnabled) {
      throw new HttpError(
        400,
        'EMAIL_REQUIRED',
        'Email is required unless phone-only registration is enabled.',
      );
    }

    this.assertPasswordIsValid(input.password);
    const now = this.clock.now();
    const passwordHash = await this.passwordHasher.hash(input.password);
    const createResult = await this.repository.createUser({
      id: randomUUID(),
      email,
      phone,
      passwordHash,
      emailVerified: email !== null && !this.config.emailVerificationRequired,
      now,
    });

    if (createResult.status === 'conflict') {
      throw new HttpError(
        409,
        'IDENTIFIER_ALREADY_REGISTERED',
        `${createResult.field === 'email' ? 'Email' : 'Phone'} is already registered.`,
      );
    }

    const user = createResult.user;

    if (this.config.emailVerificationRequired && user.email !== null && !user.emailVerified) {
      const token = this.opaqueTokens.issue();
      const expiresAt = addMilliseconds(now, this.config.emailVerificationTtlMs);
      await this.repository.storeEmailVerificationToken({
        id: randomUUID(),
        userId: user.id,
        tokenHash: token.hash,
        expiresAt,
        now,
      });
      await this.deliverEmailVerificationSafely(user, token.value, expiresAt);

      return {
        kind: 'verification-required',
        response: {
          user: toPublicUser(user),
          emailVerificationRequired: true,
        },
      };
    }

    return { kind: 'authenticated', session: await this.issueSession(user, now) };
  }

  public async login(input: LoginInput): Promise<AuthenticatedSession> {
    const identifier = normalizeIdentifier(input.identifier, this.config.phoneLoginEnabled);
    const user = identifier === null ? null : await this.findUser(identifier);
    const passwordMatches = await this.passwordHasher.compare(
      input.password,
      user?.passwordHash ?? DUMMY_BCRYPT_HASH,
    );

    if (user === null || !passwordMatches) {
      throw new HttpError(401, 'INVALID_CREDENTIALS', 'Invalid identifier or password.');
    }

    if (
      this.config.emailVerificationRequired &&
      user.email !== null &&
      !user.emailVerified
    ) {
      throw new HttpError(403, 'EMAIL_NOT_VERIFIED', 'Email verification is required.');
    }

    return this.issueSession(user, this.clock.now());
  }

  public async refresh(refreshToken: string): Promise<AuthenticatedSession> {
    if (!isPlausibleOpaqueToken(refreshToken)) {
      throw new HttpError(401, 'INVALID_REFRESH_TOKEN', 'Refresh session is invalid.');
    }

    const now = this.clock.now();
    const replacementToken = this.opaqueTokens.issue();
    const replacementSessionId = randomUUID();
    const result = await this.repository.rotateRefreshSession({
      currentTokenHash: hashOpaqueToken(refreshToken),
      replacement: {
        id: replacementSessionId,
        tokenHash: replacementToken.hash,
        expiresAt: addMilliseconds(now, this.config.refreshTtlMs),
        now,
      },
      now,
    });

    if (result.status !== 'rotated') {
      throw new HttpError(401, 'INVALID_REFRESH_TOKEN', 'Refresh session is invalid.');
    }

    const accessToken = await this.accessTokens.issue(
      result.user.id,
      replacementSessionId,
      now,
    );

    return {
      refreshToken: replacementToken.value,
      response: {
        user: toPublicUser(result.user),
        accessToken: accessToken.token,
        tokenType: 'Bearer',
        expiresIn: accessToken.expiresIn,
      },
    };
  }

  public async logout(refreshToken: string | null): Promise<void> {
    if (refreshToken === null || !isPlausibleOpaqueToken(refreshToken)) {
      return;
    }

    await this.repository.revokeRefreshSessionByHash(
      hashOpaqueToken(refreshToken),
      this.clock.now(),
    );
  }

  public async requestPasswordReset(rawIdentifier: string): Promise<void> {
    const identifier = normalizeIdentifier(rawIdentifier, this.config.phoneLoginEnabled);

    if (identifier === null) {
      return;
    }

    const user = await this.findUser(identifier);

    if (user === null) {
      return;
    }

    const now = this.clock.now();
    const token = this.opaqueTokens.issue();
    const expiresAt = addMilliseconds(now, this.config.passwordResetTtlMs);
    await this.repository.storePasswordResetToken({
      id: randomUUID(),
      userId: user.id,
      tokenHash: token.hash,
      expiresAt,
      now,
    });

    try {
      await this.tokenDelivery.sendPasswordReset({
        userId: user.id,
        destination: identifier.value,
        destinationType: identifier.kind,
        token: token.value,
        expiresAt,
      });
    } catch (error) {
      console.error('Password-reset token delivery failed.', error);
    }
  }

  public async confirmPasswordReset(token: string, newPassword: string): Promise<void> {
    if (!isPlausibleOpaqueToken(token)) {
      throw new HttpError(
        400,
        'INVALID_OR_EXPIRED_RESET_TOKEN',
        'Password-reset token is invalid, expired, or already used.',
      );
    }

    this.assertPasswordIsValid(newPassword);
    const newPasswordHash = await this.passwordHasher.hash(newPassword);
    const user = await this.repository.replacePasswordUsingResetToken(
      hashOpaqueToken(token),
      newPasswordHash,
      this.clock.now(),
    );

    if (user === null) {
      throw new HttpError(
        400,
        'INVALID_OR_EXPIRED_RESET_TOKEN',
        'Password-reset token is invalid, expired, or already used.',
      );
    }
  }

  public async verifyEmail(token: string): Promise<AuthenticatedSession> {
    if (!this.config.emailVerificationRequired) {
      throw new HttpError(404, 'NOT_FOUND', 'Route was not found.');
    }

    if (!isPlausibleOpaqueToken(token)) {
      throw new HttpError(
        400,
        'INVALID_OR_EXPIRED_VERIFICATION_TOKEN',
        'Email-verification token is invalid, expired, or already used.',
      );
    }

    const now = this.clock.now();
    const user = await this.repository.verifyEmailUsingToken(hashOpaqueToken(token), now);

    if (user === null) {
      throw new HttpError(
        400,
        'INVALID_OR_EXPIRED_VERIFICATION_TOKEN',
        'Email-verification token is invalid, expired, or already used.',
      );
    }

    return this.issueSession(user, now);
  }

  private normalizeRegistrationEmail(rawEmail: string | undefined): string | null {
    if (rawEmail === undefined) {
      return null;
    }

    const email = normalizeEmail(rawEmail);

    if (email === null) {
      throw new HttpError(400, 'INVALID_EMAIL', 'Email format is invalid.');
    }

    return email;
  }

  private normalizeRegistrationPhone(rawPhone: string | undefined): string | null {
    if (rawPhone === undefined) {
      return null;
    }

    if (!this.config.phoneLoginEnabled) {
      throw new HttpError(400, 'PHONE_AUTH_DISABLED', 'Phone authentication is disabled.');
    }

    const phone = normalizePhone(rawPhone);

    if (phone === null) {
      throw new HttpError(
        400,
        'INVALID_PHONE',
        'Phone must use E.164 format, for example +79991234567.',
      );
    }

    return phone;
  }

  private assertPasswordIsValid(password: string): void {
    const issue = validatePassword(password, this.config.passwordMinimumLength);

    if (issue !== null) {
      throw new HttpError(400, 'WEAK_PASSWORD', issue);
    }
  }

  private async findUser(identifier: NormalizedIdentifier): Promise<UserRecord | null> {
    return identifier.kind === 'email'
      ? this.repository.findUserByEmail(identifier.value)
      : this.repository.findUserByPhone(identifier.value);
  }

  private async issueSession(user: UserRecord, now: Date): Promise<AuthenticatedSession> {
    const refreshToken = this.opaqueTokens.issue();
    const sessionId = randomUUID();
    await this.repository.createRefreshSession({
      id: sessionId,
      userId: user.id,
      tokenHash: refreshToken.hash,
      expiresAt: addMilliseconds(now, this.config.refreshTtlMs),
      now,
    });
    const accessToken = await this.accessTokens.issue(user.id, sessionId, now);

    return {
      refreshToken: refreshToken.value,
      response: {
        user: toPublicUser(user),
        accessToken: accessToken.token,
        tokenType: 'Bearer',
        expiresIn: accessToken.expiresIn,
      },
    };
  }

  private async deliverEmailVerificationSafely(
    user: UserRecord,
    token: string,
    expiresAt: Date,
  ): Promise<void> {
    if (user.email === null) {
      return;
    }

    try {
      await this.tokenDelivery.sendEmailVerification({
        userId: user.id,
        email: user.email,
        token,
        expiresAt,
      });
    } catch (error) {
      console.error('Email-verification token delivery failed.', error);
    }
  }
}
