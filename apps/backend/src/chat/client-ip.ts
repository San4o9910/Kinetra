import { isIP } from 'node:net';

export interface ChatClientIpInput {
  readonly remoteAddress: string | undefined;
  readonly xForwardedFor: string | readonly string[] | undefined;
}

const UNKNOWN_CLIENT_IP = 'unknown';
const MAX_FORWARDED_HEADER_LENGTH = 2_048;
const MAX_FORWARDED_ADDRESSES = 64;

const mappedIpv4 = (canonicalIpv6: string): string | null => {
  const match = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/u.exec(canonicalIpv6);

  if (match === null) {
    return null;
  }

  const high = Number.parseInt(match[1]!, 16);
  const low = Number.parseInt(match[2]!, 16);
  return `${high >>> 8}.${high & 0xff}.${low >>> 8}.${low & 0xff}`;
};

const normalizeIpLiteral = (rawValue: string): string | null => {
  const value = rawValue.trim();
  const version = isIP(value);

  if (version === 4) {
    return value
      .split('.')
      .map((part) => String(Number(part)))
      .join('.');
  }

  if (version !== 6) {
    return null;
  }

  try {
    const hostname = new URL(`http://[${value}]/`).hostname;
    const canonical = hostname.slice(1, -1).toLowerCase();
    return mappedIpv4(canonical) ?? canonical;
  } catch {
    return null;
  }
};

/**
 * Resolves the rate-limit identity using an exact number of trusted reverse-proxy hops.
 * Invalid or insufficient forwarding data falls back to the direct transport peer so an
 * untrusted header can only make the limiter stricter, never create a new attacker-chosen key.
 */
export const resolveChatClientIp = (input: ChatClientIpInput, trustedProxyHops: number): string => {
  const remoteAddress = normalizeIpLiteral(input.remoteAddress ?? '');

  if (remoteAddress === null) {
    return UNKNOWN_CLIENT_IP;
  }

  if (!Number.isSafeInteger(trustedProxyHops) || trustedProxyHops <= 0) {
    return remoteAddress;
  }

  if (
    typeof input.xForwardedFor !== 'string' ||
    input.xForwardedFor.length < 1 ||
    input.xForwardedFor.length > MAX_FORWARDED_HEADER_LENGTH
  ) {
    return remoteAddress;
  }

  const forwarded = input.xForwardedFor.split(',').map((entry) => normalizeIpLiteral(entry));

  if (
    forwarded.length < trustedProxyHops ||
    forwarded.length > MAX_FORWARDED_ADDRESSES ||
    forwarded.some((entry) => entry === null)
  ) {
    return remoteAddress;
  }

  return forwarded[forwarded.length - trustedProxyHops] ?? remoteAddress;
};
