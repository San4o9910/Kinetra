import type {
  AuthTokenDelivery,
  EmailVerificationDelivery,
  PasswordResetDelivery,
} from '../../src/auth/delivery.js';

export class CapturingAuthTokenDelivery implements AuthTokenDelivery {
  public readonly passwordResets: PasswordResetDelivery[] = [];
  public readonly emailVerifications: EmailVerificationDelivery[] = [];

  public async sendPasswordReset(message: PasswordResetDelivery): Promise<void> {
    this.passwordResets.push(message);
  }

  public async sendEmailVerification(message: EmailVerificationDelivery): Promise<void> {
    this.emailVerifications.push(message);
  }
}
