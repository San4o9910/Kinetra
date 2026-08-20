export interface PasswordResetDelivery {
  readonly userId: string;
  readonly destination: string;
  readonly destinationType: 'email' | 'phone';
  readonly token: string;
  readonly expiresAt: Date;
}

export interface EmailVerificationDelivery {
  readonly userId: string;
  readonly email: string;
  readonly token: string;
  readonly expiresAt: Date;
}

export interface AuthTokenDelivery {
  sendPasswordReset(message: PasswordResetDelivery): Promise<void>;
  sendEmailVerification(message: EmailVerificationDelivery): Promise<void>;
}

const maskDestination = (value: string): string => {
  const atIndex = value.indexOf('@');

  if (atIndex > 0) {
    return `${value.slice(0, 1)}***${value.slice(atIndex)}`;
  }

  return value.length <= 4 ? '****' : `***${value.slice(-4)}`;
};

export class ConsoleAuthTokenDelivery implements AuthTokenDelivery {
  public async sendPasswordReset(message: PasswordResetDelivery): Promise<void> {
    console.info(
      `[local-auth-token] password-reset destination=${maskDestination(message.destination)} ` +
        `token=${message.token} expiresAt=${message.expiresAt.toISOString()}`,
    );
  }

  public async sendEmailVerification(message: EmailVerificationDelivery): Promise<void> {
    console.info(
      `[local-auth-token] verify-email destination=${maskDestination(message.email)} ` +
        `token=${message.token} expiresAt=${message.expiresAt.toISOString()}`,
    );
  }
}

export class DisabledAuthTokenDelivery implements AuthTokenDelivery {
  public async sendPasswordReset(_message: PasswordResetDelivery): Promise<void> {
    // Delivery is intentionally disabled for this adapter.
  }

  public async sendEmailVerification(_message: EmailVerificationDelivery): Promise<void> {
    // Delivery is intentionally disabled for this adapter.
  }
}
