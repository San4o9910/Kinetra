import { isIP } from 'node:net';

import { z } from 'zod';

import { isPublicPushAddress } from './network-security.js';

const normalizedHostname = (hostname: string): string =>
  hostname.replace(/^\[|\]$/gu, '').toLowerCase();

const isObviousLocalEndpoint = (url: URL): boolean => {
  const hostname = normalizedHostname(url.hostname);

  if (hostname === 'localhost' || hostname.endsWith('.localhost')) {
    return true;
  }

  const family = isIP(hostname);
  return family !== 0 && !isPublicPushAddress(hostname);
};

export const pushEndpointSchema = z
  .string()
  .min(1, 'endpoint is required.')
  .max(4_096, 'endpoint is too long.')
  .url('endpoint must be a valid HTTPS URL.')
  .refine((value) => value === value.trim(), 'endpoint must not contain surrounding whitespace.')
  .superRefine((value, context) => {
    let url: URL;

    try {
      url = new URL(value);
    } catch {
      context.addIssue({ code: 'custom', message: 'endpoint must be a valid HTTPS URL.' });
      return;
    }

    if (url.protocol !== 'https:') {
      context.addIssue({ code: 'custom', message: 'endpoint must use HTTPS.' });
    }

    if (url.username.length > 0 || url.password.length > 0 || url.hash.length > 0) {
      context.addIssue({
        code: 'custom',
        message: 'endpoint must not contain credentials or a fragment.',
      });
    }

    if (isObviousLocalEndpoint(url)) {
      context.addIssue({ code: 'custom', message: 'endpoint host is not allowed.' });
    }
  });

const subscriptionKeySchema = (name: string, minimum: number, maximum: number) =>
  z
    .string()
    .min(minimum, `${name} is too short.`)
    .max(maximum, `${name} is too long.`)
    .regex(/^[A-Za-z0-9_-]+$/u, `${name} must use base64url encoding.`);

export const pushSubscriptionSchema = z
  .object({
    endpoint: pushEndpointSchema,
    keys: z
      .object({
        p256dh: subscriptionKeySchema('keys.p256dh', 40, 256),
        auth: subscriptionKeySchema('keys.auth', 8, 128),
      })
      .strict(),
    expirationTime: z
      .number()
      .int('expirationTime must be an integer timestamp.')
      .min(0)
      .max(8_640_000_000_000_000)
      .nullable(),
  })
  .strict();

export const pushUnsubscribeSchema = z
  .object({
    endpoint: pushEndpointSchema,
  })
  .strict();
