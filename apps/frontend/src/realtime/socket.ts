import type {
  ChatClientToServerEvents,
  ChatConversationUpdatedEvent,
  ChatMessageNewEvent,
  ChatReadUpdatedEvent,
  ChatServerToClientEvents,
  ChatSessionInvalidatedEvent,
} from '@kinetra/shared';
import { io, type Socket } from 'socket.io-client';

import { apiBaseUrl } from '../lib/api';
import type {
  ChatConnectionState as FeatureChatConnectionState,
  ChatRealtimeClient as FeatureChatRealtimeClient,
  ChatRealtimeEvent as FeatureChatRealtimeEvent,
} from '../features/chat/types';

export type KinetraSocket = Socket<ChatServerToClientEvents, ChatClientToServerEvents>;
export type ChatConnectionState =
  'disconnected' | 'connecting' | 'catching_up' | 'connected' | 'reconnecting' | 'offline';

export type ChatRealtimeEvent =
  | { readonly type: 'message:new'; readonly payload: ChatMessageNewEvent }
  | { readonly type: 'conversation:updated'; readonly payload: ChatConversationUpdatedEvent }
  | { readonly type: 'read:updated'; readonly payload: ChatReadUpdatedEvent }
  | { readonly type: 'session:invalidated'; readonly payload: ChatSessionInvalidatedEvent }
  | { readonly type: 'connection'; readonly state: ChatConnectionState };

export type ChatRealtimeListener = (event: ChatRealtimeEvent) => void;

export interface ChatRealtimeClientOptions {
  readonly getAccessToken: () => Promise<string>;
  readonly refreshAccessToken?: () => Promise<string>;
  readonly url?: string;
}

export type ChatTokenFailureKind = 'terminal' | 'stale' | 'transient';

export const classifyChatTokenFailure = (error: unknown): ChatTokenFailureKind => {
  if (typeof error !== 'object' || error === null) {
    return 'transient';
  }

  const candidate = error as { readonly code?: unknown; readonly kind?: unknown };
  if (candidate.code === 'AUTH_SESSION_CHANGED') {
    return candidate.kind === 'auth' ? 'terminal' : 'stale';
  }

  if (
    candidate.kind === 'auth' ||
    candidate.code === 'AUTHENTICATION_REQUIRED' ||
    candidate.code === 'NO_SESSION'
  ) {
    return 'terminal';
  }

  return 'transient';
};

const tokenRetryDelay = (attempt: number): number => Math.min(8_000, 500 * 2 ** attempt);

export class ChatRealtimeSocketClient {
  private socket: KinetraSocket | null = null;
  private readonly listeners = new Set<ChatRealtimeListener>();
  private state: ChatConnectionState = 'disconnected';
  private disposed = false;
  private lifecycleVersion = 0;
  private tokenRetryTimer: ReturnType<typeof globalThis.setTimeout> | null = null;
  private tokenRetryAttempt = 0;
  private refreshInFlightLifecycle: number | null = null;

  public constructor(private readonly options: ChatRealtimeClientOptions) {}

  public get connectionState(): ChatConnectionState {
    return this.state;
  }

  public subscribe(listener: ChatRealtimeListener): () => void {
    this.listeners.add(listener);
    listener({ type: 'connection', state: this.state });
    return () => this.listeners.delete(listener);
  }

  public async connect(): Promise<void> {
    if (this.socket?.connected === true || this.state === 'connecting') {
      return;
    }

    const lifecycleVersion = this.lifecycleVersion;
    this.disposed = false;
    this.clearTokenRetryTimer();
    this.setState(this.socket === null ? 'connecting' : 'reconnecting');
    let accessToken: string;
    try {
      accessToken = await this.options.getAccessToken();
    } catch (error) {
      this.handleTokenFailure(error, lifecycleVersion, () => {
        void this.connect();
      });
      return;
    }

    if (this.disposed || this.lifecycleVersion !== lifecycleVersion) {
      return;
    }

    this.tokenRetryAttempt = 0;

    if (this.socket === null) {
      this.socket = this.createSocket(accessToken, lifecycleVersion);
    } else {
      this.socket.auth = { accessToken };
    }

    this.socket.connect();
  }

  public disconnect(): void {
    this.lifecycleVersion += 1;
    this.disposed = true;
    this.clearTokenRetryTimer();
    this.tokenRetryAttempt = 0;
    this.refreshInFlightLifecycle = null;
    this.socket?.removeAllListeners();
    this.socket?.disconnect();
    this.socket = null;
    this.setState('disconnected');
  }

  public async sync(conversationId: string, lastSequence: number): Promise<boolean> {
    const socket = this.socket;

    if (socket?.connected !== true) {
      return true;
    }

    const deltaRequired = await new Promise<boolean>((resolve) => {
      const timeout = globalThis.setTimeout(() => resolve(true), 5_000);
      socket.emit(
        'chat:sync',
        { conversation_id: conversationId, last_sequence: lastSequence },
        (response) => {
          globalThis.clearTimeout(timeout);
          resolve(response.delta_required);
        },
      );
    });

    if (socket.connected) {
      this.setState('connected');
    }

    return deltaRequired;
  }

  public markSynchronized(): void {
    if (this.socket?.connected === true) {
      this.setState('connected');
    }
  }

  private createSocket(accessToken: string, lifecycleVersion: number): KinetraSocket {
    const socket: KinetraSocket = io(`${this.options.url ?? apiBaseUrl}/chat`, {
      autoConnect: false,
      transports: ['websocket'],
      auth: { accessToken },
      reconnection: true,
      reconnectionAttempts: Number.POSITIVE_INFINITY,
      reconnectionDelay: 500,
      reconnectionDelayMax: 8_000,
      timeout: 10_000,
    });
    const isCurrentLifecycle = (): boolean =>
      !this.disposed && this.lifecycleVersion === lifecycleVersion && this.socket === socket;

    socket.on('connect', () => {
      if (isCurrentLifecycle()) {
        this.tokenRetryAttempt = 0;
        this.clearTokenRetryTimer();
        this.setState('connected');
      }
    });
    socket.on('connect_error', (error) => {
      if (!isCurrentLifecycle()) {
        return;
      }

      this.setState(
        typeof navigator !== 'undefined' && !navigator.onLine ? 'offline' : 'reconnecting',
      );

      const code = (error as { readonly data?: { readonly code?: unknown } }).data?.code;
      if (code === 'AUTHENTICATION_REQUIRED') {
        void this.reconnectWithFreshToken(socket, lifecycleVersion);
      }
    });
    socket.on('disconnect', (reason) => {
      if (!isCurrentLifecycle()) {
        return;
      }

      this.setState(
        typeof navigator !== 'undefined' && !navigator.onLine ? 'offline' : 'reconnecting',
      );

      if (reason === 'io server disconnect') {
        void this.reconnectWithFreshToken(socket, lifecycleVersion);
      }
    });
    socket.on('chat:message:new', (payload) => {
      if (isCurrentLifecycle()) this.emit({ type: 'message:new', payload });
    });
    socket.on('chat:conversation:updated', (payload) => {
      if (isCurrentLifecycle()) this.emit({ type: 'conversation:updated', payload });
    });
    socket.on('chat:read:updated', (payload) => {
      if (isCurrentLifecycle()) this.emit({ type: 'read:updated', payload });
    });
    socket.on('chat:session:invalidated', (payload) => {
      if (!isCurrentLifecycle()) {
        return;
      }

      if (payload.reason === 'token_expired') {
        this.setState('reconnecting');
        return;
      }

      this.emit({ type: 'session:invalidated', payload });
      this.disconnect();
    });

    return socket;
  }

  private async reconnectWithFreshToken(
    socket: KinetraSocket,
    lifecycleVersion: number,
  ): Promise<void> {
    if (this.refreshInFlightLifecycle === lifecycleVersion || this.tokenRetryTimer !== null) {
      return;
    }
    this.refreshInFlightLifecycle = lifecycleVersion;

    try {
      const token = await (this.options.refreshAccessToken ?? this.options.getAccessToken)();

      if (!this.disposed && this.lifecycleVersion === lifecycleVersion && this.socket === socket) {
        this.tokenRetryAttempt = 0;
        this.clearTokenRetryTimer();
        socket.auth = { accessToken: token };
        socket.connect();
      }
    } catch (error) {
      if (this.disposed || this.lifecycleVersion !== lifecycleVersion || this.socket !== socket) {
        return;
      }

      this.handleTokenFailure(error, lifecycleVersion, () => {
        void this.reconnectWithFreshToken(socket, lifecycleVersion);
      });
    } finally {
      if (this.refreshInFlightLifecycle === lifecycleVersion) {
        this.refreshInFlightLifecycle = null;
      }
    }
  }

  private handleTokenFailure(error: unknown, lifecycleVersion: number, retry: () => void): void {
    if (this.disposed || this.lifecycleVersion !== lifecycleVersion) {
      return;
    }

    const failureKind = classifyChatTokenFailure(error);
    if (failureKind === 'terminal') {
      this.emit({
        type: 'session:invalidated',
        payload: { reason: 'session_inactive' },
      });
      this.disconnect();
      return;
    }

    if (failureKind === 'stale') {
      this.disconnect();
      return;
    }

    this.setState(
      typeof navigator !== 'undefined' && !navigator.onLine ? 'offline' : 'reconnecting',
    );
    this.scheduleTokenRetry(lifecycleVersion, retry);
  }

  private scheduleTokenRetry(lifecycleVersion: number, retry: () => void): void {
    if (
      this.disposed ||
      this.lifecycleVersion !== lifecycleVersion ||
      this.tokenRetryTimer !== null
    ) {
      return;
    }

    const delay = tokenRetryDelay(this.tokenRetryAttempt);
    this.tokenRetryAttempt += 1;
    this.tokenRetryTimer = globalThis.setTimeout(() => {
      this.tokenRetryTimer = null;
      if (!this.disposed && this.lifecycleVersion === lifecycleVersion) {
        retry();
      }
    }, delay);
  }

  private clearTokenRetryTimer(): void {
    if (this.tokenRetryTimer !== null) {
      globalThis.clearTimeout(this.tokenRetryTimer);
      this.tokenRetryTimer = null;
    }
  }

  private setState(state: ChatConnectionState): void {
    if (this.state === state) {
      return;
    }

    this.state = state;
    this.emit({ type: 'connection', state });
  }

  private emit(event: ChatRealtimeEvent): void {
    for (const listener of this.listeners) {
      listener(event);
    }
  }
}

export const createSocketClient = (url = apiBaseUrl): KinetraSocket =>
  io(`${url}/chat`, {
    autoConnect: false,
    transports: ['websocket'],
  });

const featureConnectionState = (state: ChatConnectionState): FeatureChatConnectionState => {
  if (state === 'connected') return 'connected';
  if (state === 'reconnecting') return 'reconnecting';
  if (state === 'offline') return 'offline';
  return 'connecting';
};

const featureEvent = (event: ChatRealtimeEvent): FeatureChatRealtimeEvent => {
  if (event.type === 'message:new') {
    return { type: 'message:new', message: event.payload.message };
  }

  if (event.type === 'conversation:updated') {
    return { type: 'conversation:updated', ...event.payload };
  }

  if (event.type === 'read:updated') {
    return { type: 'read:updated', ...event.payload };
  }

  if (event.type === 'session:invalidated') {
    return { type: 'session:invalidated' };
  }

  return { type: 'connection', state: featureConnectionState(event.state) };
};

export const createFeatureChatRealtimeClient = (
  getAccessToken: () => Promise<string>,
  refreshAccessToken?: () => Promise<string>,
  url = apiBaseUrl,
): FeatureChatRealtimeClient => {
  const client = new ChatRealtimeSocketClient({
    getAccessToken,
    ...(refreshAccessToken === undefined ? {} : { refreshAccessToken }),
    url,
  });

  return {
    getConnectionState: () => featureConnectionState(client.connectionState),
    subscribe: (listener) => client.subscribe((event) => listener(featureEvent(event))),
    connect: () => {
      void client.connect();
    },
    disconnect: () => client.disconnect(),
    sync: (conversationId, lastSequence) => {
      void client.sync(conversationId, lastSequence);
    },
  };
};
