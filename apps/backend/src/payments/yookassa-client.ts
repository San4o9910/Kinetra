import {
  type YooKassaPayment,
  type YooKassaRefund,
  yooKassaPaymentSchema,
  yooKassaRefundSchema,
} from './schema.js';

export interface YooKassaCreatePaymentInput {
  readonly amount: {
    readonly value: string;
    readonly currency: string;
  };
  readonly capture: true;
  readonly confirmation?: {
    readonly type: 'redirect';
    readonly return_url: string;
  };
  readonly description: string;
  readonly save_payment_method?: true;
  readonly payment_method_id?: string;
  readonly metadata: Readonly<Record<string, string>>;
}

export interface YooKassaClient {
  createPayment(
    input: YooKassaCreatePaymentInput,
    idempotencyKey: string,
  ): Promise<YooKassaPayment>;
  getPayment(paymentId: string): Promise<YooKassaPayment>;
  getRefund(refundId: string): Promise<YooKassaRefund>;
}

export class YooKassaApiError extends Error {
  public constructor(
    message: string,
    public readonly statusCode: number | null,
    public readonly retryable: boolean,
  ) {
    super(message);
    this.name = 'YooKassaApiError';
  }
}

export interface HttpYooKassaClientOptions {
  readonly shopId: string;
  readonly secretKey: string;
  readonly requestTimeoutMs: number;
  readonly baseUrl?: string;
  readonly fetchImplementation?: typeof fetch;
}

const parseJson = (text: string): unknown => {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new YooKassaApiError('YooKassa returned malformed JSON.', null, true);
  }
};

export class HttpYooKassaClient implements YooKassaClient {
  private readonly baseUrl: string;
  private readonly authorization: string;
  private readonly fetchImplementation: typeof fetch;

  public constructor(private readonly options: HttpYooKassaClientOptions) {
    this.baseUrl = (options.baseUrl ?? 'https://api.yookassa.ru/v3').replace(/\/+$/u, '');
    this.authorization = `Basic ${Buffer.from(`${options.shopId}:${options.secretKey}`, 'utf8').toString('base64')}`;
    this.fetchImplementation = options.fetchImplementation ?? fetch;
  }

  public async createPayment(
    input: YooKassaCreatePaymentInput,
    idempotencyKey: string,
  ): Promise<YooKassaPayment> {
    const payload = await this.request('/payments', {
      method: 'POST',
      headers: { 'Idempotence-Key': idempotencyKey },
      body: JSON.stringify(input),
    });
    const parsed = yooKassaPaymentSchema.safeParse(payload);

    if (!parsed.success) {
      throw new YooKassaApiError('YooKassa returned an invalid payment object.', null, true);
    }

    return parsed.data;
  }

  public async getPayment(paymentId: string): Promise<YooKassaPayment> {
    const payload = await this.request(`/payments/${encodeURIComponent(paymentId)}`);
    const parsed = yooKassaPaymentSchema.safeParse(payload);

    if (!parsed.success) {
      throw new YooKassaApiError('YooKassa returned an invalid payment object.', null, true);
    }

    return parsed.data;
  }

  public async getRefund(refundId: string): Promise<YooKassaRefund> {
    const payload = await this.request(`/refunds/${encodeURIComponent(refundId)}`);
    const parsed = yooKassaRefundSchema.safeParse(payload);

    if (!parsed.success) {
      throw new YooKassaApiError('YooKassa returned an invalid refund object.', null, true);
    }

    return parsed.data;
  }

  private async request(path: string, init: RequestInit = {}): Promise<unknown> {
    let response: Response;

    try {
      response = await this.fetchImplementation(`${this.baseUrl}${path}`, {
        ...init,
        headers: {
          Accept: 'application/json',
          Authorization: this.authorization,
          ...(init.body === undefined ? {} : { 'Content-Type': 'application/json' }),
          ...init.headers,
        },
        signal: AbortSignal.timeout(this.options.requestTimeoutMs),
      });
    } catch (error) {
      throw new YooKassaApiError(
        error instanceof Error && error.name === 'TimeoutError'
          ? 'YooKassa request timed out.'
          : 'YooKassa request failed.',
        null,
        true,
      );
    }

    const text = await response.text();

    if (!response.ok) {
      throw new YooKassaApiError(
        `YooKassa request failed with HTTP ${response.status}.`,
        response.status,
        response.status === 408 || response.status === 429 || response.status >= 500,
      );
    }

    return text.length === 0 ? {} : parseJson(text);
  }
}

export class UnavailableYooKassaClient implements YooKassaClient {
  private unavailable(): never {
    throw new YooKassaApiError('YooKassa is not configured.', null, false);
  }

  public async createPayment(): Promise<YooKassaPayment> {
    return this.unavailable();
  }

  public async getPayment(): Promise<YooKassaPayment> {
    return this.unavailable();
  }

  public async getRefund(): Promise<YooKassaRefund> {
    return this.unavailable();
  }
}
