import type { ClientRequest, IncomingMessage } from 'node:http';
import { request as httpsRequest, type Agent } from 'node:https';
import { isIP } from 'node:net';

import webPush from 'web-push';

import {
  createRestrictedPushAgent,
  isBlockedPushAddressError,
  isPublicPushAddress,
} from './network-security.js';
import type { PushDeviceSubscription, PushNotificationType, PushSendResult } from './repository.js';

const MAX_PAYLOAD_BYTES = 3_072;
const DEFAULT_TTL_SECONDS = 60 * 60;
const DEFAULT_TIMEOUT_MS = 10_000;

export interface PushPayload {
  readonly type: PushNotificationType;
  readonly title: string;
  readonly body: string;
  readonly url: '/schedule' | '/progress';
  readonly occurrence_key: string;
}

interface VapidDetails {
  readonly subject: string;
  readonly publicKey: string;
  readonly privateKey: string;
}

interface TransportSubscription {
  readonly endpoint: string;
  readonly expirationTime: number | null;
  readonly keys: {
    readonly p256dh: string;
    readonly auth: string;
  };
}

interface TransportOptions {
  readonly vapidDetails: VapidDetails;
  readonly TTL: number;
  readonly urgency: 'normal';
  readonly timeout: number;
  readonly agent: Agent;
}

export interface WebPushTransport {
  sendNotification(
    subscription: TransportSubscription,
    payload: string,
    options: TransportOptions,
  ): Promise<unknown>;
}

export interface PushSender {
  send(subscription: PushDeviceSubscription, payload: PushPayload): Promise<PushSendResult>;
}

interface WebPushRequestOptions {
  readonly method: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly agent: Agent;
}

export type WebPushRequestPrimitive = (
  endpoint: string,
  options: WebPushRequestOptions,
  onResponse: (response: IncomingMessage) => void,
) => ClientRequest;

const productionHttpsRequest: WebPushRequestPrimitive = (endpoint, options, onResponse) =>
  httpsRequest(endpoint, options, onResponse);

const timeoutError = (): Error => {
  const error = new Error('Web Push request exceeded its deadline.');
  error.name = 'TimeoutError';
  return error;
};

const responseStatusError = (statusCode: number): Error & { readonly statusCode: number } =>
  Object.assign(new Error('Push service returned a non-success status.'), { statusCode });

const sendRestrictedHttpsRequest = (
  requestDetails: ReturnType<typeof webPush.generateRequestDetails>,
  agent: Agent,
  deadlineMs: number,
  requestPrimitive: WebPushRequestPrimitive,
): Promise<void> =>
  new Promise((resolve, reject) => {
    let settled = false;
    const deadlineState: { timer: NodeJS.Timeout | null } = { timer: null };
    const settle = (error?: unknown): void => {
      if (settled) {
        return;
      }

      settled = true;

      if (deadlineState.timer !== null) {
        clearTimeout(deadlineState.timer);
      }

      if (error === undefined) {
        resolve();
      } else {
        reject(error);
      }
    };
    const request = requestPrimitive(
      requestDetails.endpoint,
      {
        method: requestDetails.method,
        headers: requestDetails.headers,
        agent,
      },
      (response) => {
        const statusCode = response.statusCode;

        if (statusCode === undefined) {
          response.destroy();
          settle(new Error('Push service returned no HTTP status.'));
          return;
        }

        if (statusCode < 200 || statusCode > 299) {
          response.destroy();
          settle(responseStatusError(statusCode));
          return;
        }

        response.once('end', () => settle());
        response.once('aborted', () => settle(new Error('Push service response was aborted.')));
        response.once('error', settle);
        response.resume();
      },
    );

    request.once('error', settle);
    deadlineState.timer = setTimeout(() => {
      const error = timeoutError();
      request.destroy(error);
      settle(error);
    }, deadlineMs);
    request.end(requestDetails.body ?? undefined);
  });

export const createWebPushTransport = (
  requestPrimitive: WebPushRequestPrimitive = productionHttpsRequest,
): WebPushTransport => ({
  sendNotification: async (subscription, payload, options) => {
    const requestDetails = webPush.generateRequestDetails(subscription, payload, {
      vapidDetails: options.vapidDetails,
      TTL: options.TTL,
      urgency: options.urgency,
    });
    await sendRestrictedHttpsRequest(
      requestDetails,
      options.agent,
      options.timeout,
      requestPrimitive,
    );
  },
});

const defaultTransport = createWebPushTransport();

const statusCodeFrom = (error: unknown): number | null => {
  if (
    typeof error === 'object' &&
    error !== null &&
    'statusCode' in error &&
    typeof error.statusCode === 'number'
  ) {
    return error.statusCode;
  }

  return null;
};

const safeFailureCode = (error: unknown): string => {
  if (isBlockedPushAddressError(error)) {
    return 'endpoint_address_blocked';
  }

  const statusCode = statusCodeFrom(error);

  if (statusCode !== null) {
    return `http_${statusCode}`;
  }

  if (error instanceof Error && ['AbortError', 'TimeoutError'].includes(error.name)) {
    return 'network_timeout';
  }

  return 'network_error';
};

const isPayloadValid = (payload: PushPayload): boolean =>
  payload.title.trim().length >= 1 &&
  payload.title.length <= 100 &&
  payload.body.trim().length >= 1 &&
  payload.body.length <= 240 &&
  payload.occurrence_key.trim().length >= 1 &&
  payload.occurrence_key.length <= 512 &&
  ((payload.type === 'workout_reminder' && payload.url === '/schedule') ||
    (payload.type === 'weekly_survey_reminder' && payload.url === '/progress'));

const endpointFailureCode = (endpoint: string): string | null => {
  let url: URL;

  try {
    url = new URL(endpoint);
  } catch {
    return 'invalid_endpoint';
  }

  if (
    url.protocol !== 'https:' ||
    url.username.length > 0 ||
    url.password.length > 0 ||
    url.hash.length > 0
  ) {
    return 'invalid_endpoint';
  }

  const hostname = url.hostname.replace(/^\[|\]$/gu, '');
  return isIP(hostname) !== 0 && !isPublicPushAddress(hostname) ? 'endpoint_address_blocked' : null;
};

export class WebPushSender implements PushSender {
  public constructor(
    private readonly vapidDetails: VapidDetails,
    private readonly transport: WebPushTransport = defaultTransport,
    private readonly ttlSeconds = DEFAULT_TTL_SECONDS,
    private readonly timeoutMs = DEFAULT_TIMEOUT_MS,
    private readonly agent = createRestrictedPushAgent(),
  ) {}

  public async send(
    subscription: PushDeviceSubscription,
    payload: PushPayload,
  ): Promise<PushSendResult> {
    if (!isPayloadValid(payload)) {
      return { kind: 'failed', errorCode: 'invalid_payload' };
    }

    const endpointError = endpointFailureCode(subscription.endpoint);

    if (endpointError !== null) {
      return { kind: 'failed', errorCode: endpointError };
    }

    const serialized = JSON.stringify(payload);

    if (Buffer.byteLength(serialized, 'utf8') > MAX_PAYLOAD_BYTES) {
      return { kind: 'failed', errorCode: 'payload_too_large' };
    }

    try {
      await this.transport.sendNotification(
        {
          endpoint: subscription.endpoint,
          expirationTime: subscription.expirationTime?.getTime() ?? null,
          keys: { p256dh: subscription.p256dh, auth: subscription.auth },
        },
        serialized,
        {
          vapidDetails: this.vapidDetails,
          TTL: this.ttlSeconds,
          urgency: 'normal',
          timeout: this.timeoutMs,
          agent: this.agent,
        },
      );
      return { kind: 'sent' };
    } catch (error) {
      const statusCode = statusCodeFrom(error);

      if (statusCode === 404 || statusCode === 410) {
        return { kind: 'invalid', errorCode: statusCode === 404 ? 'http_404' : 'http_410' };
      }

      return { kind: 'failed', errorCode: safeFailureCode(error) };
    }
  }
}

export class UnavailablePushSender implements PushSender {
  public async send(): Promise<PushSendResult> {
    return { kind: 'failed', errorCode: 'not_configured' };
  }
}
