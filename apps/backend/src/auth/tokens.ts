import { createHash, randomBytes, randomUUID } from 'node:crypto';

import { jwtVerify, SignJWT, type JWTPayload } from 'jose';

export interface IssuedOpaqueToken {
  readonly value: string;
  readonly hash: string;
}

export interface AccessTokenClaims {
  readonly sub: string;
  readonly sid: string;
  readonly type: 'access';
  readonly iss: string;
  readonly aud: string;
  readonly iat: number;
  readonly exp: number;
  readonly jti: string;
}

export interface IssuedAccessToken {
  readonly token: string;
  readonly expiresIn: number;
}

interface VerifiedAccessPayload extends JWTPayload {
  readonly sub: string;
  readonly sid: string;
  readonly type: 'access';
  readonly iss: string;
  readonly aud: string | string[];
  readonly iat: number;
  readonly exp: number;
  readonly jti: string;
}

const isVerifiedAccessPayload = (
  payload: JWTPayload,
  issuer: string,
  audience: string,
  ttlSeconds: number,
): payload is VerifiedAccessPayload =>
  typeof payload.sub === 'string' &&
  typeof payload.sid === 'string' &&
  payload.type === 'access' &&
  typeof payload.iss === 'string' &&
  payload.iss === issuer &&
  (payload.aud === audience || (Array.isArray(payload.aud) && payload.aud.includes(audience))) &&
  typeof payload.iat === 'number' &&
  typeof payload.exp === 'number' &&
  typeof payload.jti === 'string' &&
  payload.exp > payload.iat &&
  payload.exp - payload.iat <= ttlSeconds;

export const isPlausibleOpaqueToken = (token: string): boolean =>
  token.length >= 32 && token.length <= 256 && /^[A-Za-z0-9_-]+$/u.test(token);

export const hashOpaqueToken = (token: string): string =>
  createHash('sha256').update(token, 'utf8').digest('hex');

export class OpaqueTokenService {
  public issue(): IssuedOpaqueToken {
    const value = randomBytes(48).toString('base64url');
    return { value, hash: hashOpaqueToken(value) };
  }
}

export class HmacJwtAccessTokenService {
  private readonly secret: Uint8Array;

  public constructor(
    secret: string,
    private readonly issuer: string,
    private readonly audience: string,
    private readonly ttlSeconds: number,
  ) {
    if (Buffer.byteLength(secret, 'utf8') < 32) {
      throw new Error('Access-token secret must contain at least 32 UTF-8 bytes.');
    }

    this.secret = new TextEncoder().encode(secret);
  }

  public async issue(userId: string, sessionId: string, now: Date): Promise<IssuedAccessToken> {
    const issuedAt = Math.floor(now.getTime() / 1000);
    const expiresAt = issuedAt + this.ttlSeconds;
    const token = await new SignJWT({ sid: sessionId, type: 'access' })
      .setProtectedHeader({ alg: 'HS256', typ: 'JWT' })
      .setSubject(userId)
      .setIssuer(this.issuer)
      .setAudience(this.audience)
      .setIssuedAt(issuedAt)
      .setExpirationTime(expiresAt)
      .setJti(randomUUID())
      .sign(this.secret);

    return {
      token,
      expiresIn: this.ttlSeconds,
    };
  }

  public async verify(token: string, now = new Date()): Promise<AccessTokenClaims> {
    const { payload } = await jwtVerify(token, this.secret, {
      algorithms: ['HS256'],
      issuer: this.issuer,
      audience: this.audience,
      typ: 'JWT',
      currentDate: now,
      clockTolerance: 5,
      maxTokenAge: this.ttlSeconds + 5,
      requiredClaims: ['sub', 'sid', 'type', 'iat', 'exp', 'jti'],
    });

    if (!isVerifiedAccessPayload(payload, this.issuer, this.audience, this.ttlSeconds)) {
      throw new Error('Invalid access-token claims.');
    }

    return {
      sub: payload.sub,
      sid: payload.sid,
      type: 'access',
      iss: payload.iss,
      aud: this.audience,
      iat: payload.iat,
      exp: payload.exp,
      jti: payload.jti,
    };
  }
}
