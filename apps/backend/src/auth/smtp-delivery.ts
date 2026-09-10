import { Resolver } from 'node:dns';
import { isIPv4 } from 'node:net';
import { connect, type ConnectionOptions, type TLSSocket } from 'node:tls';

import nodemailer, {
  type SendMailOptions,
  type SMTPSentMessageInfo,
  type SMTPTransportOptions,
} from 'nodemailer';

import type {
  AuthTokenDelivery,
  EmailVerificationDelivery,
  PasswordResetDelivery,
} from './delivery.js';
import { isPlausibleOpaqueToken } from './tokens.js';

export interface SmtpDeliveryConfig {
  readonly service: 'yandex' | 'gmail';
  readonly username: string;
  readonly password: string;
  readonly appOrigin: string;
  readonly timeoutMs: number;
}

interface MailTransport {
  sendMail(message: SendMailOptions): Promise<SMTPSentMessageInfo>;
  close(): void;
}

interface SmtpResolver {
  resolve4(
    hostname: string,
    callback: (error: NodeJS.ErrnoException | null, addresses: string[]) => void,
  ): void;
  cancel(): void;
}

/** Injectable boundaries for offline transport tests; configuration cannot override endpoints. */
export interface SmtpDeliveryDependencies {
  readonly createTransport?: (options: SMTPTransportOptions) => MailTransport;
  readonly createResolver?: (timeoutMs: number) => SmtpResolver;
  readonly connect?: (options: ConnectionOptions) => TLSSocket;
}

const INVALID_CONFIG = 'Invalid auth SMTP configuration.';
const INVALID_MESSAGE = 'Invalid auth SMTP message.';
const DELIVERY_FAILED = 'Auth email delivery failed.';
const DELIVERY_TIMEOUT = 'Auth email delivery timed out.';
const SMTP_HOSTS = { yandex: 'smtp.yandex.ru', gmail: 'smtp.gmail.com' } as const;

const isSingleMailbox = (value: string): boolean => {
  if (typeof value !== 'string' || value.length > 254) return false;
  const parts = value.split('@');
  const local = parts[0];
  const domain = parts[1];
  return (
    parts.length === 2 &&
    local !== undefined &&
    domain !== undefined &&
    local.length > 0 &&
    local.length <= 64 &&
    /^[A-Za-z0-9!#$%&'*+/=?^_`{|}~.-]+$/u.test(local) &&
    !local.startsWith('.') &&
    !local.endsWith('.') &&
    !local.includes('..') &&
    domain.includes('.') &&
    domain
      .split('.')
      .every((label) => /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?$/u.test(label))
  );
};

/** A separate connection for each token lets a deadline terminate the actual SMTP socket. */
export class SmtpAuthTokenDelivery implements AuthTokenDelivery {
  private readonly config: SmtpDeliveryConfig;

  public constructor(
    config: SmtpDeliveryConfig,
    private readonly dependencies: SmtpDeliveryDependencies = {},
  ) {
    try {
      const origin = new URL(config.appOrigin);
      if (
        (config.service !== 'yandex' && config.service !== 'gmail') ||
        !isSingleMailbox(config.username) ||
        !/^[A-Za-z0-9_+-]+(?:\.[A-Za-z0-9_+-]+)*@/u.test(config.username) ||
        !/^[\x21-\x7e]{16,256}$/u.test(config.password) ||
        config.appOrigin !== origin.origin ||
        origin.protocol !== 'https:' ||
        origin.username !== '' ||
        origin.password !== '' ||
        origin.pathname !== '/' ||
        origin.search !== '' ||
        origin.hash !== '' ||
        !Number.isSafeInteger(config.timeoutMs) ||
        config.timeoutMs < 1_000 ||
        config.timeoutMs > 30_000
      ) {
        throw new Error(INVALID_CONFIG);
      }
      this.config = { ...config, appOrigin: origin.origin };
    } catch {
      // URL/parser errors may contain the original input; never retain them.
      throw new Error(INVALID_CONFIG);
    }
  }

  public async sendPasswordReset(message: PasswordResetDelivery): Promise<void> {
    if (message.destinationType !== 'email') {
      throw new Error('Auth SMTP delivery supports email recipients only.');
    }
    await this.send('password_reset', message.destination, message.token, message.expiresAt);
  }

  public async sendEmailVerification(message: EmailVerificationDelivery): Promise<void> {
    await this.send('email_verification', message.email, message.token, message.expiresAt);
  }

  private async send(
    event: 'password_reset' | 'email_verification',
    recipient: string,
    token: string,
    expiresAt: Date,
  ): Promise<void> {
    if (
      !isSingleMailbox(recipient) ||
      typeof token !== 'string' ||
      !isPlausibleOpaqueToken(token) ||
      !(expiresAt instanceof Date) ||
      !Number.isFinite(expiresAt.getTime())
    ) {
      throw new Error(INVALID_MESSAGE);
    }

    const isReset = event === 'password_reset';
    const link = new URL(
      isReset ? '/auth/reset-password' : '/auth/verify-email',
      this.config.appOrigin,
    );
    link.hash = `token=${token}`;
    const message: SendMailOptions = {
      from: { name: 'Kinetra', address: this.config.username },
      to: [{ name: '', address: recipient }],
      envelope: { from: this.config.username, to: [recipient] },
      subject: isReset ? 'Kinetra — восстановление пароля' : 'Kinetra — подтверждение почты',
      text: [
        isReset
          ? 'Чтобы установить новый пароль в Kinetra, откройте ссылку:'
          : 'Чтобы подтвердить свою почту в Kinetra, откройте ссылку:',
        link.href,
        `Ссылка действует до ${expiresAt.toISOString()} (UTC) и используется один раз.`,
        'Если вы не запрашивали это письмо, просто проигнорируйте его.',
        'Никому не пересылайте эту ссылку.',
      ].join('\n\n'),
      headers: { 'Auto-Submitted': 'auto-generated', 'X-Auto-Response-Suppress': 'All' },
      disableFileAccess: true,
      disableUrlAccess: true,
    };

    const host = SMTP_HOSTS[this.config.service];
    const timeoutMs = this.config.timeoutMs;
    const phaseTimeoutMs = Math.min(timeoutMs, 5_000);
    const createTransport = this.dependencies.createTransport ?? nodemailer.createTransport;
    const createResolver =
      this.dependencies.createResolver ??
      ((dnsTimeoutMs: number) => new Resolver({ timeout: dnsTimeoutMs, tries: 1 }));
    const connectSocket = this.dependencies.connect ?? connect;

    await new Promise<void>((resolve, reject) => {
      let settled = false;
      let socketRequested = false;
      let transport: MailTransport | undefined;
      let socket: TLSSocket | undefined;
      let resolver: SmtpResolver | undefined;
      let dnsTimer: ReturnType<typeof setTimeout> | undefined;
      let connectionTimer: ReturnType<typeof setTimeout> | undefined;
      const totalTimer = setTimeout(() => finish(DELIVERY_TIMEOUT), timeoutMs);

      const finish = (failure?: string): void => {
        if (settled) return;
        settled = true;
        clearTimeout(totalTimer);
        clearTimeout(dnsTimer);
        clearTimeout(connectionTimer);
        // close() alone is graceful in Nodemailer and cannot cancel an active send.
        // Own the DNS request and TLS socket so nothing continues after our deadline.
        try {
          resolver?.cancel();
        } catch {
          // Never expose errors containing provider or credential details.
        }
        try {
          socket?.destroy();
        } catch {
          // Destruction is best effort after an already closed socket.
        }
        try {
          transport?.close();
        } catch {
          // Transport cleanup errors must not leak provider details.
        }
        if (failure === undefined) resolve();
        else reject(new Error(failure));
      };

      try {
        transport = createTransport({
          host,
          port: 465,
          secure: true,
          pool: false,
          forceAuth: true,
          auth: { user: this.config.username, pass: this.config.password },
          tls: { rejectUnauthorized: true, minVersion: 'TLSv1.2', servername: host },
          dnsTimeout: phaseTimeoutMs,
          connectionTimeout: phaseTimeoutMs,
          greetingTimeout: phaseTimeoutMs,
          socketTimeout: phaseTimeoutMs,
          logger: false,
          debug: false,
          transactionLog: false,
          maxRecipients: 1,
          disableFileAccess: true,
          disableUrlAccess: true,
          getSocket: (_options, callback) => {
            if (settled || socketRequested) {
              callback(new Error(DELIVERY_FAILED));
              finish(DELIVERY_FAILED);
              return;
            }
            socketRequested = true;
            let handedOff = false;
            const failSocket = (): void => {
              if (!handedOff) {
                handedOff = true;
                callback(new Error(DELIVERY_FAILED));
              }
              finish(DELIVERY_FAILED);
            };
            try {
              resolver = createResolver(phaseTimeoutMs);
              dnsTimer = setTimeout(() => finish(DELIVERY_TIMEOUT), phaseTimeoutMs);
              // The approved host has IPv4 egress. Resolve the fixed provider only;
              // there is no configurable SMTP address, proxy or connection fallback.
              resolver.resolve4(host, (error, addresses) => {
                clearTimeout(dnsTimer);
                if (settled) {
                  failSocket();
                  return;
                }
                const address = addresses?.[0];
                if (error || address === undefined || !isIPv4(address)) {
                  failSocket();
                  return;
                }
                try {
                  socket = connectSocket({
                    host: address,
                    port: 465,
                    servername: host,
                    rejectUnauthorized: true,
                    minVersion: 'TLSv1.2',
                  });
                  connectionTimer = setTimeout(() => finish(DELIVERY_TIMEOUT), phaseTimeoutMs);
                  socket.on('error', failSocket);
                  socket.once('close', () => finish(DELIVERY_FAILED));
                  socket.once('secureConnect', () => {
                    clearTimeout(connectionTimer);
                    if (settled || !socket?.authorized) {
                      failSocket();
                      return;
                    }
                    handedOff = true;
                    callback(null, { connection: socket, secured: true });
                  });
                } catch {
                  failSocket();
                }
              });
            } catch {
              failSocket();
            }
          },
        });
        void transport.sendMail(message).then(
          (result) => {
            const accepted =
              Array.isArray(result?.accepted) &&
              result.accepted.length === 1 &&
              typeof result.accepted[0] === 'string' &&
              result.accepted[0].toLowerCase() === recipient.toLowerCase() &&
              Array.isArray(result.rejected) &&
              result.rejected.length === 0;
            finish(accepted ? undefined : DELIVERY_FAILED);
          },
          () => finish(DELIVERY_FAILED),
        );
      } catch {
        finish(DELIVERY_FAILED);
      }
    });
  }
}
