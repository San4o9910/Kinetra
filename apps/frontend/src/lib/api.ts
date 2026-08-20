import type {
  ApiErrorResponse,
  AuthSessionResponse,
  HealthResponse,
  MeResponse,
  SurveySubmission,
} from '@kinetra/shared';

const configuredApiUrl =
  typeof import.meta.env === 'object' ? import.meta.env.VITE_API_URL : undefined;
const defaultApiUrl =
  typeof window === 'undefined'
    ? 'http://localhost:3000'
    : `${window.location.protocol}//${window.location.hostname}:3000`;

export const apiBaseUrl = (configuredApiUrl ?? defaultApiUrl).replace(/\/$/u, '');

export type ApiErrorKind = 'auth' | 'validation' | 'network' | 'server' | 'request';

export class ApiRequestError extends Error {
  public constructor(
    message: string,
    public readonly status: number,
    public readonly code: string,
    public readonly kind: ApiErrorKind,
  ) {
    super(message);
    this.name = 'ApiRequestError';
  }
}

interface ApiClientOptions {
  readonly baseUrl: string;
  readonly fetchImpl?: typeof fetch;
}

const errorKindForStatus = (status: number): ApiErrorKind => {
  if (status === 401 || status === 403) {
    return 'auth';
  }

  if (status === 400 || status === 409 || status === 422 || status === 429) {
    return 'validation';
  }

  return status >= 500 ? 'server' : 'request';
};

const isAbortError = (error: unknown): boolean =>
  error instanceof DOMException && error.name === 'AbortError';

const removeLegacyStoredToken = (): void => {
  try {
    window.localStorage.removeItem('kinetra.accessToken');
  } catch {
    // Storage can be unavailable in hardened/private browser modes.
  }
};

if (typeof window !== 'undefined') {
  removeLegacyStoredToken();
}

export class ApiClient {
  private accessToken: string | null = null;
  private refreshInFlight: Promise<string | null> | null = null;
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;

  public constructor({ baseUrl, fetchImpl = fetch }: ApiClientOptions) {
    this.baseUrl = baseUrl.replace(/\/$/u, '');
    this.fetchImpl = fetchImpl;
  }

  public hasAccessToken(): boolean {
    return this.accessToken !== null;
  }

  public clearSession(): void {
    this.accessToken = null;
  }

  public async login(identifier: string, password: string): Promise<AuthSessionResponse> {
    const response = await this.safeFetch('/api/v1/auth/login', {
      method: 'POST',
      credentials: 'include',
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ identifier: identifier.trim(), password }),
    });
    const session = await this.readJsonOrThrow<AuthSessionResponse>(response);
    this.accessToken = session.accessToken;
    return session;
  }

  public async bootstrapSession(): Promise<boolean> {
    if (this.accessToken !== null) {
      return true;
    }

    return (await this.refreshAccessToken()) !== null;
  }

  public async logout(): Promise<void> {
    try {
      const response = await this.safeFetch('/api/v1/auth/logout', {
        method: 'POST',
        credentials: 'include',
        headers: {
          Accept: 'application/json',
          'Content-Type': 'application/json',
        },
        body: '{}',
      });

      if (!response.ok && response.status !== 401) {
        await this.throwResponseError(response);
      }
    } finally {
      this.clearSession();
    }
  }

  public async fetchMe(signal?: AbortSignal): Promise<MeResponse> {
    return this.authenticatedJsonRequest<MeResponse>('/api/v1/me', {
      method: 'GET',
      ...(signal === undefined ? {} : { signal }),
    });
  }

  public async saveSurvey(survey: SurveySubmission): Promise<MeResponse> {
    return this.authenticatedJsonRequest<MeResponse>('/api/v1/me/survey', {
      method: 'PUT',
      body: JSON.stringify(survey),
    });
  }

  public async fetchHealth(signal: AbortSignal): Promise<HealthResponse> {
    const response = await this.safeFetch('/health', {
      headers: { Accept: 'application/json' },
      signal,
    });
    return this.readJsonOrThrow<HealthResponse>(response);
  }

  private async authenticatedJsonRequest<T>(
    path: string,
    init: RequestInit,
    allowRefresh = true,
  ): Promise<T> {
    const token = this.accessToken ?? (await this.refreshAccessToken());

    if (token === null) {
      throw new ApiRequestError('Сессия завершена. Войдите в аккаунт.', 401, 'NO_SESSION', 'auth');
    }

    const headers = new Headers(init.headers);
    headers.set('Accept', 'application/json');
    headers.set('Authorization', `Bearer ${token}`);

    if (init.body !== undefined && init.body !== null) {
      headers.set('Content-Type', 'application/json');
    }

    const response = await this.safeFetch(path, {
      ...init,
      credentials: 'include',
      headers,
    });

    if (response.status === 401 && allowRefresh) {
      this.accessToken = null;
      const refreshedToken = await this.refreshAccessToken();

      if (refreshedToken === null) {
        throw new ApiRequestError(
          'Сессия завершена. Войдите в аккаунт.',
          401,
          'NO_SESSION',
          'auth',
        );
      }

      return this.authenticatedJsonRequest<T>(path, init, false);
    }

    return this.readJsonOrThrow<T>(response);
  }

  private async refreshAccessToken(): Promise<string | null> {
    if (this.refreshInFlight !== null) {
      return this.refreshInFlight;
    }

    const refresh = async (): Promise<string | null> => {
      const response = await this.safeFetch('/api/v1/auth/refresh', {
        method: 'POST',
        credentials: 'include',
        headers: {
          Accept: 'application/json',
          'Content-Type': 'application/json',
        },
        body: '{}',
      });

      if (response.status === 401) {
        this.accessToken = null;
        return null;
      }

      const session = await this.readJsonOrThrow<AuthSessionResponse>(response);
      this.accessToken = session.accessToken;
      return session.accessToken;
    };

    const runWithCrossTabLock = async (): Promise<string | null> => {
      if (typeof navigator !== 'undefined' && navigator.locks !== undefined) {
        return navigator.locks.request('kinetra-refresh-session', { mode: 'exclusive' }, refresh);
      }

      return refresh();
    };

    const pendingRefresh = runWithCrossTabLock().finally(() => {
      this.refreshInFlight = null;
    });
    this.refreshInFlight = pendingRefresh;
    return pendingRefresh;
  }

  private async safeFetch(path: string, init: RequestInit): Promise<Response> {
    try {
      return await this.fetchImpl.call(globalThis, `${this.baseUrl}${path}`, init);
    } catch (error) {
      if (isAbortError(error)) {
        throw error;
      }

      throw new ApiRequestError(
        'Не удалось связаться с сервером. Проверьте интернет и попробуйте ещё раз.',
        0,
        'NETWORK_ERROR',
        'network',
      );
    }
  }

  private async readJsonOrThrow<T>(response: Response): Promise<T> {
    if (!response.ok) {
      await this.throwResponseError(response);
    }

    return (await response.json()) as T;
  }

  private async throwResponseError(response: Response): Promise<never> {
    let body: ApiErrorResponse | null = null;

    try {
      body = (await response.json()) as ApiErrorResponse;
    } catch {
      body = null;
    }

    throw new ApiRequestError(
      body?.error.message ?? `Запрос завершился с ошибкой ${response.status}.`,
      response.status,
      body?.error.code ?? 'REQUEST_FAILED',
      errorKindForStatus(response.status),
    );
  }
}

const apiClient = new ApiClient({ baseUrl: apiBaseUrl });

export const login = (identifier: string, password: string): Promise<AuthSessionResponse> =>
  apiClient.login(identifier, password);
export const bootstrapSession = (): Promise<boolean> => apiClient.bootstrapSession();
export const logout = (): Promise<void> => apiClient.logout();
export const fetchMe = (signal?: AbortSignal): Promise<MeResponse> => apiClient.fetchMe(signal);
export const saveSurvey = (survey: SurveySubmission): Promise<MeResponse> =>
  apiClient.saveSurvey(survey);
export const fetchHealth = (signal: AbortSignal): Promise<HealthResponse> =>
  apiClient.fetchHealth(signal);
