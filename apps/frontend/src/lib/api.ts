import type {
  ApiErrorResponse,
  AuthSessionResponse,
  BaseLessonsResponse,
  ChatConversationListResponse,
  ChatConversationResponse,
  ChatConversationSummaryResponse,
  ChatMessagePageResponse,
  ChatPhotoAccessResponse,
  ChatPhotoResponse,
  ChatReadResponse,
  ChatSendMessageRequest,
  ChatSendMessageResponse,
  ChatSessionResponse,
  CompleteWorkoutRequest,
  CreatePaymentRequest,
  CreatePaymentResponse,
  GoalResponse,
  HealthResponse,
  LessonProgressResponse,
  MeResponse,
  MetricsResponse,
  NotificationPreferences,
  ProgressResponse,
  PushPublicKeyResponse,
  PushSubscriptionRequest,
  PushSubscriptionResponse,
  PushUnsubscribeRequest,
  ScheduleResponse,
  SettingsProfileResponse,
  SubscriptionResponse,
  SurveyGoal,
  SurveySubmission,
  UpdateLessonProgressRequest,
  WeeklyMetricsInput,
  WeekResponse,
} from '@kinetra/shared';

import type { ChatRuntimeApi } from '../features/chat/types';

const configuredApiUrl =
  typeof import.meta.env === 'object' ? import.meta.env.VITE_API_URL : undefined;
const defaultApiUrl =
  typeof window === 'undefined'
    ? 'http://localhost:3000'
    : `${window.location.protocol}//${window.location.hostname}:3000`;

export const resolveApiBaseUrl = (
  configuredUrl: string | undefined,
  fallbackUrl: string,
): string => {
  const normalized = configuredUrl?.trim();
  return (normalized === undefined || normalized.length === 0 ? fallbackUrl : normalized).replace(
    /\/$/u,
    '',
  );
};

export const apiBaseUrl = resolveApiBaseUrl(configuredApiUrl, defaultApiUrl);

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

export interface PushSubscriptionDeleteOptions {
  readonly signal?: AbortSignal;
  readonly allowRefresh?: boolean;
}

export interface ChatMessagePageOptions {
  readonly before_sequence?: number;
  readonly after_sequence?: number;
  readonly limit?: number;
  readonly signal?: AbortSignal;
}

export interface ChatInboxOptions {
  readonly cursor?: string;
  readonly limit?: number;
  readonly filter: 'all' | 'unread';
  readonly query?: string;
  readonly signal?: AbortSignal;
}

export interface ChatPhotoUploadOptions {
  readonly file: File;
  readonly idempotencyKey: string;
  readonly onProgress?: (percent: number) => void;
  readonly signal?: AbortSignal;
}

export type PreparedPushSubscriptionDeletion = (
  data: PushUnsubscribeRequest,
  signal?: AbortSignal,
) => Promise<void>;

const errorKindForStatus = (status: number): ApiErrorKind => {
  if (status === 401) {
    return 'auth';
  }

  if (status === 400 || status === 409 || status === 422 || status === 429 || status === 403) {
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
  private logoutAccessToken: string | null = null;
  private authSubjectId: string | null = null;
  private authEpoch = 0;
  private terminalSubjectMismatch = false;
  private authMutationQueue: Promise<void> = Promise.resolve();
  private refreshInFlight: {
    readonly epoch: number;
    readonly promise: Promise<string | null>;
  } | null = null;
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;

  public constructor({ baseUrl, fetchImpl = fetch }: ApiClientOptions) {
    this.baseUrl = baseUrl.replace(/\/$/u, '');
    this.fetchImpl = fetchImpl;
  }

  public hasAccessToken(): boolean {
    return this.accessToken !== null;
  }

  public getInMemoryAccessToken(): string | null {
    return this.accessToken;
  }

  public getInMemoryAuthSubjectId(): string | null {
    return this.authSubjectId;
  }

  public async ensureAccessToken(): Promise<string> {
    const token = this.accessToken ?? (await this.refreshAccessToken());

    if (token === null) {
      throw new ApiRequestError('Сессия завершена. Войдите в аккаунт.', 401, 'NO_SESSION', 'auth');
    }

    return token;
  }

  public async refreshInMemoryAccessToken(): Promise<string> {
    this.accessToken = null;
    return this.ensureAccessToken();
  }

  public clearSession(): void {
    this.invalidateInMemorySession();
  }

  public async login(identifier: string, password: string): Promise<AuthSessionResponse> {
    this.terminalSubjectMismatch = false;
    const epoch = this.invalidateInMemorySession();

    return this.enqueueAuthMutation(async () => {
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

      if (this.authEpoch !== epoch) {
        throw this.authSessionChangedError();
      }

      this.authSubjectId = session.user.id;
      this.accessToken = session.accessToken;
      this.logoutAccessToken = session.accessToken;
      return session;
    });
  }

  public async bootstrapSession(): Promise<boolean> {
    if (this.accessToken !== null) {
      return true;
    }

    return (await this.refreshAccessToken()) !== null;
  }

  public async logout(): Promise<void> {
    const subjectId = this.authSubjectId;
    const accessToken = this.logoutAccessToken;
    const epoch = this.invalidateInMemorySession();

    try {
      if (subjectId === null || accessToken === null) {
        return;
      }

      await this.enqueueAuthMutation(async () => {
        // Never rotate the shared refresh cookie as part of logout. Without
        // cross-tab Web Locks, a late account-A refresh response could overwrite
        // a newer account-B login cookie. The server atomically revokes only when
        // this captured bearer subject still owns the request cookie.
        const response = await this.safeFetch('/api/v1/auth/logout', {
          method: 'POST',
          credentials: 'include',
          headers: {
            Accept: 'application/json',
            Authorization: `Bearer ${accessToken}`,
            'Content-Type': 'application/json',
          },
          body: '{}',
        });

        if (!response.ok && response.status !== 401) {
          await this.throwResponseError(response);
        }
      });
    } catch (error) {
      if (error instanceof ApiRequestError && error.code === 'AUTH_COORDINATION_UNAVAILABLE') {
        // Local logout remains safe when this browser cannot provide an
        // origin-wide mutation lock; never fall back to a racy cookie request.
        return;
      }
      throw error;
    } finally {
      if (this.authEpoch === epoch) {
        this.accessToken = null;
      }
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

  public async completeOnboarding(): Promise<MeResponse> {
    return this.authenticatedJsonRequest<MeResponse>('/api/v1/me/onboarding-complete', {
      method: 'PUT',
    });
  }

  public async getBaseLessons(signal?: AbortSignal): Promise<BaseLessonsResponse> {
    return this.authenticatedJsonRequest<BaseLessonsResponse>('/api/v1/base-lessons', {
      method: 'GET',
      ...(signal === undefined ? {} : { signal }),
    });
  }

  public async updateLessonProgress(
    lessonId: string,
    data: UpdateLessonProgressRequest,
  ): Promise<LessonProgressResponse> {
    return this.authenticatedJsonRequest<LessonProgressResponse>(
      `/api/v1/base-lessons/${encodeURIComponent(lessonId)}/progress`,
      {
        method: 'PUT',
        body: JSON.stringify(data),
        keepalive: true,
      },
    );
  }

  public async completeBaseProgram(): Promise<MeResponse> {
    return this.authenticatedJsonRequest<MeResponse>('/api/v1/base-lessons/complete-program', {
      method: 'PUT',
    });
  }

  public async getCurrentWeek(signal?: AbortSignal): Promise<WeekResponse> {
    return this.authenticatedJsonRequest<WeekResponse>('/api/v1/program/current-week', {
      method: 'GET',
      ...(signal === undefined ? {} : { signal }),
    });
  }

  public async getSchedule(signal?: AbortSignal): Promise<ScheduleResponse> {
    return this.authenticatedJsonRequest<ScheduleResponse>('/api/v1/program/schedule', {
      method: 'GET',
      ...(signal === undefined ? {} : { signal }),
    });
  }

  public async getProgress(signal?: AbortSignal): Promise<ProgressResponse> {
    return this.authenticatedJsonRequest<ProgressResponse>('/api/v1/progress', {
      method: 'GET',
      ...(signal === undefined ? {} : { signal }),
    });
  }

  public async submitWeeklyMetrics(data: WeeklyMetricsInput): Promise<MetricsResponse> {
    return this.authenticatedJsonRequest<MetricsResponse>('/api/v1/progress/weekly-metrics', {
      method: 'PUT',
      body: JSON.stringify(data),
    });
  }

  public async updateGoal(goal: SurveyGoal): Promise<GoalResponse> {
    return this.authenticatedJsonRequest<GoalResponse>('/api/v1/progress/goal', {
      method: 'PUT',
      body: JSON.stringify({ goal }),
    });
  }

  public async getSubscription(signal?: AbortSignal): Promise<SubscriptionResponse> {
    return this.authenticatedJsonRequest<SubscriptionResponse>('/api/v1/settings/subscription', {
      method: 'GET',
      ...(signal === undefined ? {} : { signal }),
    });
  }

  public async createPayment(returnUrl: string): Promise<CreatePaymentResponse> {
    const body: CreatePaymentRequest = { return_url: returnUrl };

    return this.authenticatedJsonRequest<CreatePaymentResponse>('/api/v1/payments/create', {
      method: 'POST',
      body: JSON.stringify(body),
    });
  }

  public async cancelSubscription(): Promise<SubscriptionResponse> {
    return this.authenticatedJsonRequest<SubscriptionResponse>(
      '/api/v1/payments/cancel-subscription',
      { method: 'POST' },
    );
  }

  public async getSettingsProfile(signal?: AbortSignal): Promise<SettingsProfileResponse> {
    return this.authenticatedJsonRequest<SettingsProfileResponse>('/api/v1/settings/profile', {
      method: 'GET',
      ...(signal === undefined ? {} : { signal }),
    });
  }

  public async getChatSession(signal?: AbortSignal): Promise<ChatSessionResponse> {
    return this.authenticatedJsonRequest<ChatSessionResponse>('/api/v1/chat/session', {
      method: 'GET',
      ...(signal === undefined ? {} : { signal }),
    });
  }

  public async createChatConversation(signal?: AbortSignal): Promise<ChatConversationResponse> {
    return this.authenticatedJsonRequest<ChatConversationResponse>('/api/v1/chat/conversations', {
      method: 'POST',
      body: '{}',
      ...(signal === undefined ? {} : { signal }),
    });
  }

  public async getChatInbox(options: ChatInboxOptions): Promise<ChatConversationListResponse> {
    const query = new URLSearchParams({ filter: options.filter });

    if (options.cursor !== undefined) query.set('cursor', options.cursor);
    if (options.limit !== undefined) query.set('limit', String(options.limit));
    if (options.query !== undefined && options.query.length > 0) query.set('query', options.query);

    return this.authenticatedJsonRequest<ChatConversationListResponse>(
      `/api/v1/chat/conversations?${query.toString()}`,
      {
        method: 'GET',
        ...(options.signal === undefined ? {} : { signal: options.signal }),
      },
    );
  }

  public async getChatConversationSummary(
    conversationId: string,
    signal?: AbortSignal,
  ): Promise<ChatConversationSummaryResponse> {
    return this.authenticatedJsonRequest<ChatConversationSummaryResponse>(
      `/api/v1/chat/conversations/${encodeURIComponent(conversationId)}`,
      {
        method: 'GET',
        ...(signal === undefined ? {} : { signal }),
      },
    );
  }

  public async getChatMessages(
    conversationId: string,
    options: ChatMessagePageOptions = {},
  ): Promise<ChatMessagePageResponse> {
    const query = new URLSearchParams();

    if (options.before_sequence !== undefined) {
      query.set('before_sequence', String(options.before_sequence));
    }
    if (options.after_sequence !== undefined) {
      query.set('after_sequence', String(options.after_sequence));
    }
    if (options.limit !== undefined) query.set('limit', String(options.limit));
    const suffix = query.size === 0 ? '' : `?${query.toString()}`;

    return this.authenticatedJsonRequest<ChatMessagePageResponse>(
      `/api/v1/chat/conversations/${encodeURIComponent(conversationId)}/messages${suffix}`,
      {
        method: 'GET',
        ...(options.signal === undefined ? {} : { signal: options.signal }),
      },
    );
  }

  public async sendChatMessage(
    conversationId: string,
    request: ChatSendMessageRequest,
    signal?: AbortSignal,
  ): Promise<ChatSendMessageResponse> {
    return this.authenticatedJsonRequest<ChatSendMessageResponse>(
      `/api/v1/chat/conversations/${encodeURIComponent(conversationId)}/messages`,
      {
        method: 'POST',
        body: JSON.stringify(request),
        ...(signal === undefined ? {} : { signal }),
      },
    );
  }

  public async markChatRead(
    conversationId: string,
    throughSequence: number,
    signal?: AbortSignal,
  ): Promise<ChatReadResponse> {
    return this.authenticatedJsonRequest<ChatReadResponse>(
      `/api/v1/chat/conversations/${encodeURIComponent(conversationId)}/read`,
      {
        method: 'PUT',
        body: JSON.stringify({ through_sequence: throughSequence }),
        ...(signal === undefined ? {} : { signal }),
      },
    );
  }

  public async uploadChatPhoto(
    conversationId: string,
    options: ChatPhotoUploadOptions,
  ): Promise<ChatPhotoResponse> {
    const form = new FormData();
    form.append('photo', options.file);

    return this.authenticatedMultipartRequest<ChatPhotoResponse>(
      `/api/v1/chat/conversations/${encodeURIComponent(conversationId)}/photos`,
      form,
      options.idempotencyKey,
      options.onProgress,
      options.signal,
    );
  }

  public async getChatPhotoStatus(
    photoId: string,
    signal?: AbortSignal,
  ): Promise<ChatPhotoResponse> {
    return this.authenticatedJsonRequest<ChatPhotoResponse>(
      `/api/v1/chat/photos/${encodeURIComponent(photoId)}/status`,
      { method: 'GET', ...(signal === undefined ? {} : { signal }) },
    );
  }

  public async getChatPhotoAccess(
    photoId: string,
    signal?: AbortSignal,
  ): Promise<ChatPhotoAccessResponse> {
    return this.authenticatedJsonRequest<ChatPhotoAccessResponse>(
      `/api/v1/chat/photos/${encodeURIComponent(photoId)}/access`,
      { method: 'GET', ...(signal === undefined ? {} : { signal }) },
    );
  }

  public async updateNotifications(data: NotificationPreferences): Promise<void> {
    await this.authenticatedVoidRequest('/api/v1/settings/notifications', {
      method: 'PUT',
      body: JSON.stringify(data),
      keepalive: true,
    });
  }

  public async getPushPublicKey(): Promise<PushPublicKeyResponse> {
    return this.authenticatedJsonRequest<PushPublicKeyResponse>('/api/v1/push/public-key', {
      method: 'GET',
    });
  }

  public async registerPushSubscription(
    data: PushSubscriptionRequest,
  ): Promise<PushSubscriptionResponse> {
    return this.authenticatedJsonRequest<PushSubscriptionResponse>('/api/v1/push/subscriptions', {
      method: 'POST',
      body: JSON.stringify(data),
    });
  }

  public async deletePushSubscription(
    data: PushUnsubscribeRequest,
    options: PushSubscriptionDeleteOptions = {},
  ): Promise<void> {
    await this.authenticatedVoidRequest(
      '/api/v1/push/subscriptions',
      {
        method: 'DELETE',
        body: JSON.stringify(data),
        ...(options.signal === undefined ? {} : { signal: options.signal }),
      },
      options.allowRefresh ?? true,
    );
  }

  public preparePushSubscriptionDeletion(): PreparedPushSubscriptionDeletion {
    const accessToken = this.accessToken;

    return async (data, signal) => {
      if (accessToken === null) {
        throw new ApiRequestError(
          'Сессия завершена. Войдите в аккаунт.',
          401,
          'NO_SESSION',
          'auth',
        );
      }

      const response = await this.requestWithAccessToken(
        '/api/v1/push/subscriptions',
        {
          method: 'DELETE',
          body: JSON.stringify(data),
          ...(signal === undefined ? {} : { signal }),
        },
        accessToken,
      );

      if (!response.ok) {
        await this.throwResponseError(response);
      }
    };
  }

  public prepareAccountDeletion(confirm: string): () => Promise<void> {
    const accessToken = this.accessToken;

    if (accessToken === null) {
      throw new ApiRequestError('Сессия завершена. Войдите в аккаунт.', 401, 'NO_SESSION', 'auth');
    }

    return async () => {
      const response = await this.requestWithAccessToken(
        '/api/v1/settings/account',
        {
          method: 'DELETE',
          body: JSON.stringify({ confirm }),
        },
        accessToken,
      );

      if (!response.ok) {
        await this.throwResponseError(response);
      }

      this.clearSession();
    };
  }

  public async getWeek(weekNumber: number, signal?: AbortSignal): Promise<WeekResponse> {
    return this.authenticatedJsonRequest<WeekResponse>(
      `/api/v1/program/weeks/${encodeURIComponent(String(weekNumber))}`,
      {
        method: 'GET',
        ...(signal === undefined ? {} : { signal }),
      },
    );
  }

  public async completeWorkout(data: CompleteWorkoutRequest): Promise<WeekResponse> {
    return this.authenticatedJsonRequest<WeekResponse>('/api/v1/program/complete-workout', {
      method: 'PUT',
      body: JSON.stringify(data),
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
    const epoch = this.authEpoch;

    try {
      const response = await this.authenticatedRequest(path, init, allowRefresh);
      const body = await this.readJsonOrThrow<T>(response);

      if (this.authEpoch !== epoch) {
        throw this.authSessionChangedError();
      }

      return body;
    } catch (error) {
      if (this.isTerminalSubjectMismatchError(error)) {
        throw error;
      }

      if (this.authEpoch !== epoch) {
        throw this.authSessionChangedError();
      }

      throw error;
    }
  }

  private async authenticatedVoidRequest(
    path: string,
    init: RequestInit,
    allowRefresh = true,
  ): Promise<void> {
    const epoch = this.authEpoch;

    try {
      await this.authenticatedRequest(path, init, allowRefresh);
    } catch (error) {
      if (this.isTerminalSubjectMismatchError(error)) {
        throw error;
      }

      if (this.authEpoch !== epoch) {
        throw this.authSessionChangedError();
      }

      throw error;
    }

    if (this.authEpoch !== epoch) {
      throw this.authSessionChangedError();
    }
  }

  private async authenticatedRequest(
    path: string,
    init: RequestInit,
    allowRefresh = true,
  ): Promise<Response> {
    const epoch = this.authEpoch;
    const token = this.accessToken ?? (await this.refreshAccessToken());

    if (this.authEpoch !== epoch) {
      throw this.authSessionChangedError();
    }

    if (token === null) {
      throw new ApiRequestError('Сессия завершена. Войдите в аккаунт.', 401, 'NO_SESSION', 'auth');
    }

    const response = await this.requestWithAccessToken(path, init, token);

    if (this.authEpoch !== epoch) {
      throw this.authSessionChangedError();
    }

    if (response.status === 401 && allowRefresh) {
      if (this.accessToken === token) {
        this.accessToken = null;
      }
      const refreshedToken =
        this.accessToken !== null ? this.accessToken : await this.refreshAccessToken();

      if (this.authEpoch !== epoch) {
        throw this.authSessionChangedError();
      }

      if (refreshedToken === null) {
        throw new ApiRequestError(
          'Сессия завершена. Войдите в аккаунт.',
          401,
          'NO_SESSION',
          'auth',
        );
      }

      return this.authenticatedRequest(path, init, false);
    }

    if (!response.ok) {
      await this.throwResponseError(response);
    }

    return response;
  }

  private async authenticatedMultipartRequest<T>(
    path: string,
    form: FormData,
    idempotencyKey: string,
    onProgress?: (percent: number) => void,
    signal?: AbortSignal,
    allowRefresh = true,
  ): Promise<T> {
    const epoch = this.authEpoch;
    const token = this.accessToken ?? (await this.refreshAccessToken());

    if (this.authEpoch !== epoch) {
      throw this.authSessionChangedError();
    }

    if (token === null) {
      throw new ApiRequestError('Сессия завершена. Войдите в аккаунт.', 401, 'NO_SESSION', 'auth');
    }

    const response = await this.sendMultipartWithXhr(
      path,
      form,
      token,
      idempotencyKey,
      onProgress,
      signal,
    );

    if (this.authEpoch !== epoch) {
      throw this.authSessionChangedError();
    }

    if (response.status === 401 && allowRefresh) {
      if (this.accessToken === token) {
        this.accessToken = null;
      }
      const refreshedToken =
        this.accessToken !== null ? this.accessToken : await this.refreshAccessToken();
      if (this.authEpoch !== epoch) {
        throw this.authSessionChangedError();
      }
      if (refreshedToken === null) {
        throw new ApiRequestError(
          'Сессия завершена. Войдите в аккаунт.',
          401,
          'NO_SESSION',
          'auth',
        );
      }
      return this.authenticatedMultipartRequest(
        path,
        form,
        idempotencyKey,
        onProgress,
        signal,
        false,
      );
    }

    if (response.status < 200 || response.status >= 300) {
      throw this.errorFromPayload(response.status, response.body);
    }

    return response.body as T;
  }

  private async sendMultipartWithXhr(
    path: string,
    form: FormData,
    accessToken: string,
    idempotencyKey: string,
    onProgress?: (percent: number) => void,
    signal?: AbortSignal,
  ): Promise<{ readonly status: number; readonly body: unknown }> {
    return new Promise((resolve, reject) => {
      const request = new XMLHttpRequest();
      const abort = (): void => request.abort();
      request.open('POST', `${this.baseUrl}${path}`);
      request.setRequestHeader('Accept', 'application/json');
      request.setRequestHeader('Authorization', `Bearer ${accessToken}`);
      request.setRequestHeader('Idempotency-Key', idempotencyKey);
      request.withCredentials = true;
      request.upload.addEventListener('progress', (event) => {
        if (event.lengthComputable && event.total > 0) {
          onProgress?.(Math.min(100, Math.round((event.loaded / event.total) * 100)));
        }
      });
      request.addEventListener('load', () => {
        signal?.removeEventListener('abort', abort);
        let body: unknown = null;

        try {
          body = request.responseText.length === 0 ? null : JSON.parse(request.responseText);
        } catch {
          body = null;
        }

        resolve({ status: request.status, body });
      });
      request.addEventListener('error', () => {
        signal?.removeEventListener('abort', abort);
        reject(
          new ApiRequestError(
            'Не удалось загрузить фото. Проверьте интернет и попробуйте ещё раз.',
            0,
            'NETWORK_ERROR',
            'network',
          ),
        );
      });
      request.addEventListener('abort', () => {
        signal?.removeEventListener('abort', abort);
        reject(new DOMException('The request was aborted.', 'AbortError'));
      });
      signal?.addEventListener('abort', abort, { once: true });

      if (signal?.aborted === true) {
        abort();
        return;
      }

      request.send(form);
    });
  }

  private errorFromPayload(status: number, body: unknown): ApiRequestError {
    const candidate = body as Partial<ApiErrorResponse> | null;
    return new ApiRequestError(
      candidate?.error?.message ?? `Запрос завершился с ошибкой ${status}.`,
      status,
      candidate?.error?.code ?? 'REQUEST_FAILED',
      errorKindForStatus(status),
    );
  }

  private async requestWithAccessToken(
    path: string,
    init: RequestInit,
    accessToken: string,
  ): Promise<Response> {
    const headers = new Headers(init.headers);
    headers.set('Accept', 'application/json');
    headers.set('Authorization', `Bearer ${accessToken}`);

    if (init.body !== undefined && init.body !== null) {
      headers.set('Content-Type', 'application/json');
    }

    return this.safeFetch(path, {
      ...init,
      credentials: 'include',
      headers,
    });
  }

  private async refreshAccessToken(): Promise<string | null> {
    if (this.terminalSubjectMismatch) {
      throw this.terminalSubjectMismatchError();
    }

    const epoch = this.authEpoch;
    if (this.refreshInFlight?.epoch === epoch) {
      return this.refreshInFlight.promise;
    }

    const refresh = async (): Promise<string | null> => {
      const session = await this.requestRefreshSession();
      if (session === null) {
        if (this.authEpoch === epoch) {
          this.accessToken = null;
        }
        return null;
      }

      if (this.authEpoch !== epoch) {
        return null;
      }

      if (this.authSubjectId !== null && this.authSubjectId !== session.user.id) {
        this.terminalSubjectMismatch = true;
        this.invalidateInMemorySession();
        throw this.terminalSubjectMismatchError();
      }

      this.authSubjectId = session.user.id;
      this.accessToken = session.accessToken;
      this.logoutAccessToken = session.accessToken;
      return session.accessToken;
    };

    const pendingRefresh = this.enqueueAuthMutation(refresh);
    const refreshEntry = { epoch, promise: pendingRefresh };
    this.refreshInFlight = refreshEntry;
    const clearRefreshEntry = (): void => {
      if (this.refreshInFlight === refreshEntry) {
        this.refreshInFlight = null;
      }
    };
    void pendingRefresh.then(clearRefreshEntry, clearRefreshEntry);
    return pendingRefresh;
  }

  private async requestRefreshSession(): Promise<AuthSessionResponse | null> {
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
      return null;
    }

    return this.readJsonOrThrow<AuthSessionResponse>(response);
  }

  private invalidateInMemorySession(): number {
    this.authEpoch += 1;
    this.accessToken = null;
    this.logoutAccessToken = null;
    this.authSubjectId = null;
    return this.authEpoch;
  }

  private authSessionChangedError(): ApiRequestError {
    return new ApiRequestError(
      'Сессия аккаунта изменилась. Повторите действие.',
      0,
      'AUTH_SESSION_CHANGED',
      'request',
    );
  }

  private terminalSubjectMismatchError(): ApiRequestError {
    return new ApiRequestError(
      'Сессия открыта для другого аккаунта. Войдите снова.',
      401,
      'AUTH_SESSION_CHANGED',
      'auth',
    );
  }

  private isTerminalSubjectMismatchError(error: unknown): error is ApiRequestError {
    return (
      error instanceof ApiRequestError &&
      error.code === 'AUTH_SESSION_CHANGED' &&
      error.kind === 'auth'
    );
  }

  private enqueueAuthMutation<T>(operation: () => Promise<T>): Promise<T> {
    const run = this.authMutationQueue
      .catch(() => undefined)
      .then(async () => {
        if (typeof window !== 'undefined') {
          if (typeof navigator === 'undefined' || navigator.locks === undefined) {
            throw new ApiRequestError(
              'Браузер не поддерживает безопасную синхронизацию сессии. Обновите браузер.',
              0,
              'AUTH_COORDINATION_UNAVAILABLE',
              'auth',
            );
          }

          return navigator.locks.request(
            'kinetra-auth-session-mutation',
            { mode: 'exclusive' },
            operation,
          );
        }

        return operation();
      });
    this.authMutationQueue = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
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
export const completeOnboarding = (): Promise<MeResponse> => apiClient.completeOnboarding();
export const getBaseLessons = (signal?: AbortSignal): Promise<BaseLessonsResponse> =>
  apiClient.getBaseLessons(signal);
export const updateLessonProgress = (
  lessonId: string,
  data: UpdateLessonProgressRequest,
): Promise<LessonProgressResponse> => apiClient.updateLessonProgress(lessonId, data);
export const completeBaseProgram = (): Promise<MeResponse> => apiClient.completeBaseProgram();
export const getCurrentWeek = (signal?: AbortSignal): Promise<WeekResponse> =>
  apiClient.getCurrentWeek(signal);
export const getSchedule = (signal?: AbortSignal): Promise<ScheduleResponse> =>
  apiClient.getSchedule(signal);
export const getProgress = (signal?: AbortSignal): Promise<ProgressResponse> =>
  apiClient.getProgress(signal);
export const submitWeeklyMetrics = (data: WeeklyMetricsInput): Promise<MetricsResponse> =>
  apiClient.submitWeeklyMetrics(data);
export const updateGoal = (goal: SurveyGoal): Promise<GoalResponse> => apiClient.updateGoal(goal);
export const getSubscription = (signal?: AbortSignal): Promise<SubscriptionResponse> =>
  apiClient.getSubscription(signal);
export const createPayment = (returnUrl: string): Promise<CreatePaymentResponse> =>
  apiClient.createPayment(returnUrl);
export const cancelSubscription = (): Promise<SubscriptionResponse> =>
  apiClient.cancelSubscription();
export const getSettingsProfile = (signal?: AbortSignal): Promise<SettingsProfileResponse> =>
  apiClient.getSettingsProfile(signal);
export const getChatSession = (signal?: AbortSignal): Promise<ChatSessionResponse> =>
  apiClient.getChatSession(signal);
export const createChatConversation = (signal?: AbortSignal): Promise<ChatConversationResponse> =>
  apiClient.createChatConversation(signal);
export const getChatInbox = (options: ChatInboxOptions): Promise<ChatConversationListResponse> =>
  apiClient.getChatInbox(options);
export const getChatConversationSummary = (
  conversationId: string,
  signal?: AbortSignal,
): Promise<ChatConversationSummaryResponse> =>
  apiClient.getChatConversationSummary(conversationId, signal);
export const getChatMessages = (
  conversationId: string,
  options?: ChatMessagePageOptions,
): Promise<ChatMessagePageResponse> => apiClient.getChatMessages(conversationId, options);
export const sendChatMessage = (
  conversationId: string,
  request: ChatSendMessageRequest,
  signal?: AbortSignal,
): Promise<ChatSendMessageResponse> => apiClient.sendChatMessage(conversationId, request, signal);
export const markChatRead = (
  conversationId: string,
  throughSequence: number,
  signal?: AbortSignal,
): Promise<ChatReadResponse> => apiClient.markChatRead(conversationId, throughSequence, signal);
export const uploadChatPhoto = (
  conversationId: string,
  options: ChatPhotoUploadOptions,
): Promise<ChatPhotoResponse> => apiClient.uploadChatPhoto(conversationId, options);
export const getChatPhotoStatus = (
  photoId: string,
  signal?: AbortSignal,
): Promise<ChatPhotoResponse> => apiClient.getChatPhotoStatus(photoId, signal);
export const getChatPhotoAccess = (
  photoId: string,
  signal?: AbortSignal,
): Promise<ChatPhotoAccessResponse> => apiClient.getChatPhotoAccess(photoId, signal);
export const getInMemoryAccessToken = (): string | null => apiClient.getInMemoryAccessToken();
export const ensureAccessToken = (): Promise<string> => apiClient.ensureAccessToken();
export const refreshInMemoryAccessToken = (): Promise<string> =>
  apiClient.refreshInMemoryAccessToken();
export const invalidateInMemorySession = (): void => apiClient.clearSession();
export const updateNotifications = (data: NotificationPreferences): Promise<void> =>
  apiClient.updateNotifications(data);
export const getPushPublicKey = (): Promise<PushPublicKeyResponse> => apiClient.getPushPublicKey();
export const registerPushSubscription = (
  data: PushSubscriptionRequest,
): Promise<PushSubscriptionResponse> => apiClient.registerPushSubscription(data);
export const deletePushSubscription = (
  data: PushUnsubscribeRequest,
  options?: PushSubscriptionDeleteOptions,
): Promise<void> => apiClient.deletePushSubscription(data, options);
export const preparePushSubscriptionDeletion = (): PreparedPushSubscriptionDeletion =>
  apiClient.preparePushSubscriptionDeletion();
export const prepareAccountDeletion = (confirm: string): (() => Promise<void>) =>
  apiClient.prepareAccountDeletion(confirm);
export const getWeek = (weekNumber: number, signal?: AbortSignal): Promise<WeekResponse> =>
  apiClient.getWeek(weekNumber, signal);
export const completeWorkout = (data: CompleteWorkoutRequest): Promise<WeekResponse> =>
  apiClient.completeWorkout(data);
export const fetchHealth = (signal: AbortSignal): Promise<HealthResponse> =>
  apiClient.fetchHealth(signal);

export const chatRuntimeApi: ChatRuntimeApi = {
  getSession: (signal) => getChatSession(signal),
  createConversation: async (signal) => (await createChatConversation(signal)).conversation,
  getMessages: (conversationId, query) => getChatMessages(conversationId, query),
  sendMessage: async (conversationId, request, signal) =>
    (await sendChatMessage(conversationId, request, signal)).message,
  markRead: (conversationId, throughSequence, signal) =>
    markChatRead(conversationId, throughSequence, signal),
  uploadPhoto: async (conversationId, input) => ({
    photo: (
      await uploadChatPhoto(conversationId, {
        file: input.file,
        idempotencyKey: input.idempotencyKey,
        onProgress: (percent) => input.onProgress(percent),
        ...(input.signal === undefined ? {} : { signal: input.signal }),
      })
    ).photo,
  }),
  getPhotoStatus: (photoId, signal) => getChatPhotoStatus(photoId, signal),
  getPhotoAccess: (photoId, signal) => getChatPhotoAccess(photoId, signal),
  getInbox: (query) => getChatInbox(query),
  getConversationSummary: async (conversationId, signal) => {
    try {
      return (await getChatConversationSummary(conversationId, signal)).conversation;
    } catch (error) {
      if (
        error instanceof ApiRequestError &&
        error.status === 404 &&
        error.code === 'CHAT_RESOURCE_NOT_FOUND'
      ) {
        return null;
      }

      throw error;
    }
  },
};
