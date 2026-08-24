import type { ChatPhotoAccessDto } from './types';

export const CHAT_PHOTO_ACCESS_RENEW_SKEW_MS = 5_000;
export const CHAT_PHOTO_ACCESS_MIN_TIMER_MS = 1_000;
export const CHAT_PHOTO_ACCESS_MAX_TIMER_MS = 60_000;
export const CHAT_PHOTO_ACCESS_MAX_IMMEDIATE_RENEWALS = 2;
export const CHAT_PHOTO_ACCESS_MAX_IMAGE_ERROR_RENEWALS = 1;

export type ChatPhotoAccessStatus = 'idle' | 'loading' | 'ready' | 'error';

export interface ChatPhotoAccessLifecycleState {
  readonly photoId: string | null;
  readonly status: ChatPhotoAccessStatus;
  readonly access: ChatPhotoAccessDto | null;
  readonly error: unknown | null;
}

export interface ChatPhotoAccessScheduler {
  readonly now: () => number;
  readonly setTimer: (callback: () => void, delayMilliseconds: number) => unknown;
  readonly clearTimer: (timer: unknown) => void;
}

export interface ChatPhotoAccessLifecycleOptions {
  readonly photoId: string;
  readonly loadAccess: (photoId: string, signal?: AbortSignal) => Promise<ChatPhotoAccessDto>;
  readonly onStateChange: (state: ChatPhotoAccessLifecycleState) => void;
  readonly scheduler?: ChatPhotoAccessScheduler;
}

const defaultScheduler: ChatPhotoAccessScheduler = {
  now: () => Date.now(),
  setTimer: (callback, delayMilliseconds) => globalThis.setTimeout(callback, delayMilliseconds),
  clearTimer: (timer) => globalThis.clearTimeout(timer as number),
};

export const chatPhotoAccessRenewDelay = (expiresAt: string, now: number): number | null => {
  const expiry = Date.parse(expiresAt);
  if (!Number.isFinite(expiry)) {
    return null;
  }

  return Math.max(
    CHAT_PHOTO_ACCESS_MIN_TIMER_MS,
    Math.min(CHAT_PHOTO_ACCESS_MAX_TIMER_MS, expiry - now - CHAT_PHOTO_ACCESS_RENEW_SKEW_MS),
  );
};

const invalidExpiryError = (): Error =>
  new Error('Ссылка на фотографию имеет некорректный срок действия.');

const imageLoadError = (): Error =>
  new Error('Не удалось загрузить фотографию по обновлённой ссылке.');

export class ChatPhotoAccessLifecycle {
  private readonly photoId: string;
  private readonly loadAccess: ChatPhotoAccessLifecycleOptions['loadAccess'];
  private readonly onStateChange: ChatPhotoAccessLifecycleOptions['onStateChange'];
  private readonly scheduler: ChatPhotoAccessScheduler;
  private active = false;
  private version = 0;
  private controller: AbortController | null = null;
  private timer: unknown | null = null;
  private access: ChatPhotoAccessDto | null = null;
  private state: ChatPhotoAccessLifecycleState;
  private immediateRenewals = 0;
  private imageErrorUrl: string | null = null;
  private imageErrorRenewals = 0;

  constructor(options: ChatPhotoAccessLifecycleOptions) {
    this.photoId = options.photoId;
    this.loadAccess = options.loadAccess;
    this.onStateChange = options.onStateChange;
    this.scheduler = options.scheduler ?? defaultScheduler;
    this.state = {
      photoId: this.photoId,
      status: 'idle',
      access: null,
      error: null,
    };
  }

  start(initialAccess: ChatPhotoAccessDto | null = null): void {
    this.stop();
    this.active = true;

    const initialExpiry =
      initialAccess === null ? Number.NaN : Date.parse(initialAccess.expires_at);
    if (
      initialAccess !== null &&
      Number.isFinite(initialExpiry) &&
      initialExpiry > this.scheduler.now() + CHAT_PHOTO_ACCESS_RENEW_SKEW_MS
    ) {
      this.accept(initialAccess);
      return;
    }

    this.request('initial');
  }

  stop(): void {
    this.active = false;
    this.version += 1;
    this.controller?.abort();
    this.controller = null;
    this.clearRenewTimer();
    this.access = null;
    this.immediateRenewals = 0;
    this.imageErrorUrl = null;
    this.imageErrorRenewals = 0;
    this.state = {
      photoId: this.photoId,
      status: 'idle',
      access: null,
      error: null,
    };
  }

  refresh(): void {
    if (!this.active) {
      return;
    }

    this.immediateRenewals = 0;
    this.imageErrorUrl = null;
    this.imageErrorRenewals = 0;
    this.request('manual');
  }

  handleImageError(url: string): void {
    if (!this.active || this.access?.url !== url) {
      return;
    }

    if (
      this.imageErrorUrl === url &&
      this.imageErrorRenewals >= CHAT_PHOTO_ACCESS_MAX_IMAGE_ERROR_RENEWALS
    ) {
      this.fail(imageLoadError());
      return;
    }

    this.imageErrorUrl = url;
    this.imageErrorRenewals += 1;
    this.request('image-error');
  }

  getState(): ChatPhotoAccessLifecycleState {
    return this.state;
  }

  private request(reason: 'initial' | 'expiry' | 'image-error' | 'manual'): void {
    if (!this.active) {
      return;
    }

    this.controller?.abort();
    this.clearRenewTimer();
    const controller = new AbortController();
    const requestVersion = ++this.version;
    this.controller = controller;
    const retainedAccess = reason === 'expiry' ? this.access : null;
    this.access = retainedAccess;
    this.emit('loading', retainedAccess, null);

    void this.loadAccess(this.photoId, controller.signal)
      .then((nextAccess) => {
        if (!this.isCurrent(controller, requestVersion)) {
          return;
        }

        this.controller = null;
        this.accept(nextAccess);
      })
      .catch((error: unknown) => {
        if (!this.isCurrent(controller, requestVersion)) {
          return;
        }

        this.controller = null;
        this.fail(error);
      });
  }

  private accept(nextAccess: ChatPhotoAccessDto): void {
    const expiry = Date.parse(nextAccess.expires_at);
    if (!Number.isFinite(expiry)) {
      this.fail(invalidExpiryError());
      return;
    }

    const renewAt = expiry - CHAT_PHOTO_ACCESS_RENEW_SKEW_MS;
    if (renewAt <= this.scheduler.now()) {
      this.immediateRenewals += 1;
      if (this.immediateRenewals > CHAT_PHOTO_ACCESS_MAX_IMMEDIATE_RENEWALS) {
        this.fail(invalidExpiryError());
        return;
      }
    } else {
      this.immediateRenewals = 0;
    }

    if (this.imageErrorUrl !== nextAccess.url) {
      this.imageErrorUrl = null;
      this.imageErrorRenewals = 0;
    }

    this.access = nextAccess;
    this.emit('ready', nextAccess, null);
    this.scheduleRenewal(nextAccess);
  }

  private scheduleRenewal(access: ChatPhotoAccessDto): void {
    this.clearRenewTimer();
    const delay = chatPhotoAccessRenewDelay(access.expires_at, this.scheduler.now());
    if (delay === null) {
      this.fail(invalidExpiryError());
      return;
    }

    this.timer = this.scheduler.setTimer(() => {
      this.timer = null;
      if (!this.active || this.access !== access) {
        return;
      }

      const expiry = Date.parse(access.expires_at);
      if (expiry - this.scheduler.now() > CHAT_PHOTO_ACCESS_RENEW_SKEW_MS) {
        this.scheduleRenewal(access);
        return;
      }

      this.request('expiry');
    }, delay);
  }

  private fail(error: unknown): void {
    this.controller?.abort();
    this.controller = null;
    this.clearRenewTimer();
    this.access = null;
    this.emit('error', null, error);
  }

  private emit(
    status: ChatPhotoAccessStatus,
    access: ChatPhotoAccessDto | null,
    error: unknown | null,
  ): void {
    this.state = { photoId: this.photoId, status, access, error };
    this.onStateChange(this.state);
  }

  private isCurrent(controller: AbortController, version: number): boolean {
    return (
      this.active &&
      !controller.signal.aborted &&
      this.controller === controller &&
      this.version === version
    );
  }

  private clearRenewTimer(): void {
    if (this.timer !== null) {
      this.scheduler.clearTimer(this.timer);
      this.timer = null;
    }
  }
}
