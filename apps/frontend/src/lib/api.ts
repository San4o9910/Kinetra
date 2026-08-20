import type {
  ApiErrorResponse,
  HealthResponse,
  MeResponse,
  SurveySubmission,
} from '@kinetra/shared';

export const apiBaseUrl = (import.meta.env.VITE_API_URL ?? 'http://localhost:3000').replace(
  /\/$/u,
  '',
);

const ACCESS_TOKEN_STORAGE_KEY = 'kinetra.accessToken';

export class ApiRequestError extends Error {
  public constructor(
    message: string,
    public readonly status: number,
    public readonly code: string,
  ) {
    super(message);
    this.name = 'ApiRequestError';
  }
}

export const readStoredAccessToken = (): string | null => {
  try {
    return window.localStorage.getItem(ACCESS_TOKEN_STORAGE_KEY);
  } catch {
    return null;
  }
};

export const storeAccessToken = (token: string): void => {
  window.localStorage.setItem(ACCESS_TOKEN_STORAGE_KEY, token);
};

export const clearStoredAccessToken = (): void => {
  window.localStorage.removeItem(ACCESS_TOKEN_STORAGE_KEY);
};

const authenticatedJsonRequest = async <T>(
  path: string,
  init: RequestInit,
): Promise<T> => {
  const accessToken = readStoredAccessToken();

  if (accessToken === null) {
    throw new ApiRequestError('Сессия не найдена. Войдите в аккаунт.', 401, 'NO_SESSION');
  }

  const headers = new Headers(init.headers);
  headers.set('Accept', 'application/json');
  headers.set('Authorization', `Bearer ${accessToken}`);

  if (init.body !== undefined && init.body !== null) {
    headers.set('Content-Type', 'application/json');
  }

  const response = await fetch(`${apiBaseUrl}${path}`, {
    ...init,
    headers,
  });

  if (!response.ok) {
    let errorBody: ApiErrorResponse | null = null;

    try {
      errorBody = (await response.json()) as ApiErrorResponse;
    } catch {
      errorBody = null;
    }

    if (response.status === 401) {
      clearStoredAccessToken();
    }

    throw new ApiRequestError(
      errorBody?.error.message ?? `Запрос завершился с ошибкой ${response.status}.`,
      response.status,
      errorBody?.error.code ?? 'REQUEST_FAILED',
    );
  }

  return (await response.json()) as T;
};

export const fetchHealth = async (signal: AbortSignal): Promise<HealthResponse> => {
  const response = await fetch(`${apiBaseUrl}/health`, {
    headers: {
      Accept: 'application/json',
    },
    signal,
  });

  if (!response.ok) {
    throw new Error(`Health request failed with status ${response.status}.`);
  }

  return (await response.json()) as HealthResponse;
};

export const fetchMe = async (signal: AbortSignal): Promise<MeResponse> =>
  authenticatedJsonRequest<MeResponse>('/api/v1/me', {
    method: 'GET',
    signal,
  });

export const saveSurvey = async (survey: SurveySubmission): Promise<MeResponse> =>
  authenticatedJsonRequest<MeResponse>('/api/v1/me/survey', {
    method: 'PUT',
    body: JSON.stringify(survey),
  });
