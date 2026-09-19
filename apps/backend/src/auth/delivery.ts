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

export interface WebhookDeliveryConfig {
  readonly url: string;
  readonly secret: string;
  readonly timeoutMs: number;
}

export class WebhookAuthTokenDelivery implements AuthTokenDelivery {
  public constructor(
    private readonly config: WebhookDeliveryConfig,
    private readonly request: typeof fetch = fetch,
  ) {}

  private async send(
    event: 'password_reset' | 'email_verification',
    recipient: { readonly type: 'email' | 'phone'; readonly value: string },
    token: string,
    expiresAt: Date,
  ): Promise<void> {
    let response: Response;
    try {
      response = await this.request(this.config.url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${this.config.secret}`,
        },
        body: JSON.stringify({
          version: 1,
          event,
          recipient,
          token,
          expiresAt: expiresAt.toISOString(),
        }),
        redirect: 'error',
        signal: AbortSignal.timeout(this.config.timeoutMs),
      });
    } catch {
      // Never retain the raw transport error: it can include URL, token or headers.
      throw new Error('Auth token delivery request failed.');
    }
    // Provider responses may contain private data. Neither read nor log the body.
    await response.body?.cancel().catch(() => undefined);
    if (!response.ok) throw new Error(`Auth token delivery rejected (HTTP ${response.status}).`);
  }

  public async sendPasswordReset(message: PasswordResetDelivery): Promise<void> {
    await this.send(
      'password_reset',
      { type: message.destinationType, value: message.destination },
      message.token,
      message.expiresAt,
    );
  }
  public async sendEmailVerification(message: EmailVerificationDelivery): Promise<void> {
    await this.send(
      'email_verification',
      { type: 'email', value: message.email },
      message.token,
      message.expiresAt,
    );
  }
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
