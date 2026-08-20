import type {
  AuthRepository,
  CreateUserInput,
  CreateUserResult,
  OneTimeTokenInput,
  RefreshSessionInput,
  RotateRefreshSessionInput,
  RotateRefreshSessionResult,
  UserRecord,
} from '../../src/auth/repository.js';

interface RefreshSessionRecord extends RefreshSessionInput {
  revokedAt: Date | null;
  replacedByTokenId: string | null;
}

interface OneTimeTokenRecord extends OneTimeTokenInput {
  usedAt: Date | null;
}

const cloneDate = (value: Date): Date => new Date(value.getTime());

const cloneUser = (user: UserRecord): UserRecord => ({
  ...user,
  createdAt: cloneDate(user.createdAt),
  updatedAt: cloneDate(user.updatedAt),
});

export class InMemoryAuthRepository implements AuthRepository {
  private readonly users = new Map<string, UserRecord>();
  private readonly refreshSessions = new Map<string, RefreshSessionRecord>();
  private readonly passwordResetTokens = new Map<string, OneTimeTokenRecord>();
  private readonly emailVerificationTokens = new Map<string, OneTimeTokenRecord>();

  public async findUserByEmail(email: string): Promise<UserRecord | null> {
    const user = [...this.users.values()].find((candidate) => candidate.email === email);
    return user === undefined ? null : cloneUser(user);
  }

  public async findUserByPhone(phone: string): Promise<UserRecord | null> {
    const user = [...this.users.values()].find((candidate) => candidate.phone === phone);
    return user === undefined ? null : cloneUser(user);
  }

  public async createUser(input: CreateUserInput): Promise<CreateUserResult> {
    if (
      input.email !== null &&
      [...this.users.values()].some((candidate) => candidate.email === input.email)
    ) {
      return { status: 'conflict', field: 'email' };
    }

    if (
      input.phone !== null &&
      [...this.users.values()].some((candidate) => candidate.phone === input.phone)
    ) {
      return { status: 'conflict', field: 'phone' };
    }

    const user: UserRecord = {
      id: input.id,
      email: input.email,
      phone: input.phone,
      passwordHash: input.passwordHash,
      emailVerified: input.emailVerified,
      createdAt: cloneDate(input.now),
      updatedAt: cloneDate(input.now),
    };
    this.users.set(user.id, user);
    return { status: 'created', user: cloneUser(user) };
  }

  public async createRefreshSession(input: RefreshSessionInput): Promise<void> {
    this.refreshSessions.set(input.tokenHash, {
      ...input,
      expiresAt: cloneDate(input.expiresAt),
      now: cloneDate(input.now),
      revokedAt: null,
      replacedByTokenId: null,
    });
  }

  public async rotateRefreshSession(
    input: RotateRefreshSessionInput,
  ): Promise<RotateRefreshSessionResult> {
    const current = this.refreshSessions.get(input.currentTokenHash);

    if (current === undefined) {
      return { status: 'invalid' };
    }

    if (current.revokedAt !== null) {
      await this.revokeAllRefreshSessions(current.userId, input.now);
      return { status: 'reused' };
    }

    if (current.expiresAt.getTime() <= input.now.getTime()) {
      current.revokedAt = cloneDate(input.now);
      return { status: 'invalid' };
    }

    const user = this.users.get(current.userId);

    if (user === undefined) {
      return { status: 'invalid' };
    }

    current.revokedAt = cloneDate(input.now);
    current.replacedByTokenId = input.replacement.id;
    this.refreshSessions.set(input.replacement.tokenHash, {
      id: input.replacement.id,
      userId: current.userId,
      tokenHash: input.replacement.tokenHash,
      expiresAt: cloneDate(input.replacement.expiresAt),
      now: cloneDate(input.replacement.now),
      revokedAt: null,
      replacedByTokenId: null,
    });

    return { status: 'rotated', user: cloneUser(user) };
  }

  public async revokeRefreshSessionByHash(tokenHash: string, now: Date): Promise<void> {
    const session = this.refreshSessions.get(tokenHash);

    if (session !== undefined && session.revokedAt === null) {
      session.revokedAt = cloneDate(now);
    }
  }

  public async revokeAllRefreshSessions(userId: string, now: Date): Promise<void> {
    for (const session of this.refreshSessions.values()) {
      if (session.userId === userId && session.revokedAt === null) {
        session.revokedAt = cloneDate(now);
      }
    }
  }

  public async storePasswordResetToken(input: OneTimeTokenInput): Promise<void> {
    for (const token of this.passwordResetTokens.values()) {
      if (token.userId === input.userId && token.usedAt === null) {
        token.usedAt = cloneDate(input.now);
      }
    }

    this.passwordResetTokens.set(input.tokenHash, {
      ...input,
      expiresAt: cloneDate(input.expiresAt),
      now: cloneDate(input.now),
      usedAt: null,
    });
  }

  public async replacePasswordUsingResetToken(
    tokenHash: string,
    newPasswordHash: string,
    now: Date,
  ): Promise<UserRecord | null> {
    const token = this.passwordResetTokens.get(tokenHash);

    if (
      token === undefined ||
      token.usedAt !== null ||
      token.expiresAt.getTime() <= now.getTime()
    ) {
      return null;
    }

    const user = this.users.get(token.userId);

    if (user === undefined) {
      return null;
    }

    const updatedUser: UserRecord = {
      ...user,
      passwordHash: newPasswordHash,
      updatedAt: cloneDate(now),
    };
    this.users.set(user.id, updatedUser);

    for (const candidate of this.passwordResetTokens.values()) {
      if (candidate.userId === user.id && candidate.usedAt === null) {
        candidate.usedAt = cloneDate(now);
      }
    }

    await this.revokeAllRefreshSessions(user.id, now);
    return cloneUser(updatedUser);
  }

  public async storeEmailVerificationToken(input: OneTimeTokenInput): Promise<void> {
    for (const token of this.emailVerificationTokens.values()) {
      if (token.userId === input.userId && token.usedAt === null) {
        token.usedAt = cloneDate(input.now);
      }
    }

    this.emailVerificationTokens.set(input.tokenHash, {
      ...input,
      expiresAt: cloneDate(input.expiresAt),
      now: cloneDate(input.now),
      usedAt: null,
    });
  }

  public async verifyEmailUsingToken(tokenHash: string, now: Date): Promise<UserRecord | null> {
    const token = this.emailVerificationTokens.get(tokenHash);

    if (
      token === undefined ||
      token.usedAt !== null ||
      token.expiresAt.getTime() <= now.getTime()
    ) {
      return null;
    }

    const user = this.users.get(token.userId);

    if (user === undefined) {
      return null;
    }

    const updatedUser: UserRecord = {
      ...user,
      emailVerified: true,
      updatedAt: cloneDate(now),
    };
    this.users.set(user.id, updatedUser);

    for (const candidate of this.emailVerificationTokens.values()) {
      if (candidate.userId === user.id && candidate.usedAt === null) {
        candidate.usedAt = cloneDate(now);
      }
    }

    return cloneUser(updatedUser);
  }

  public peekUserByEmail(email: string): UserRecord | null {
    const user = [...this.users.values()].find((candidate) => candidate.email === email);
    return user === undefined ? null : cloneUser(user);
  }

  public peekRefreshSession(tokenHash: string): RefreshSessionRecord | null {
    const session = this.refreshSessions.get(tokenHash);
    return session === undefined
      ? null
      : {
          ...session,
          expiresAt: cloneDate(session.expiresAt),
          now: cloneDate(session.now),
          revokedAt: session.revokedAt === null ? null : cloneDate(session.revokedAt),
        };
  }

  public peekPasswordResetToken(tokenHash: string): OneTimeTokenRecord | null {
    const token = this.passwordResetTokens.get(tokenHash);
    return token === undefined
      ? null
      : {
          ...token,
          expiresAt: cloneDate(token.expiresAt),
          now: cloneDate(token.now),
          usedAt: token.usedAt === null ? null : cloneDate(token.usedAt),
        };
  }
}
