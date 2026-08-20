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
