import type { LookupAddress, LookupOptions } from 'node:dns';
import { lookup } from 'node:dns/promises';
import { Agent } from 'node:https';
import { BlockList, isIP, type LookupFunction } from 'node:net';

const BLOCKED_ADDRESS_ERROR_CODE = 'ERR_PUSH_ENDPOINT_ADDRESS_BLOCKED';

const blockedIpv4 = new BlockList();

for (const [network, prefix] of [
  ['0.0.0.0', 8],
  ['10.0.0.0', 8],
  ['100.64.0.0', 10],
  ['127.0.0.0', 8],
  ['169.254.0.0', 16],
  ['172.16.0.0', 12],
  ['192.0.0.0', 24],
  ['192.0.2.0', 24],
  ['192.31.196.0', 24],
  ['192.52.193.0', 24],
  ['192.88.99.0', 24],
  ['192.168.0.0', 16],
  ['192.175.48.0', 24],
  ['198.18.0.0', 15],
  ['198.51.100.0', 24],
  ['203.0.113.0', 24],
  ['224.0.0.0', 4],
  ['240.0.0.0', 4],
] as const) {
  blockedIpv4.addSubnet(network, prefix, 'ipv4');
}

const globalIpv6 = new BlockList();
globalIpv6.addSubnet('2000::', 3, 'ipv6');

const blockedGlobalIpv6 = new BlockList();

for (const [network, prefix] of [
  ['2001::', 23],
  ['2001:db8::', 32],
  ['2002::', 16],
  ['2620:4f:8000::', 48],
  ['3fff::', 20],
  ['5f00::', 16],
] as const) {
  blockedGlobalIpv6.addSubnet(network, prefix, 'ipv6');
}

export const isPublicPushAddress = (address: string): boolean => {
  if (address.includes('%')) {
    return false;
  }

  const family = isIP(address);

  if (family === 4) {
    return !blockedIpv4.check(address, 'ipv4');
  }

  if (family === 6) {
    return globalIpv6.check(address, 'ipv6') && !blockedGlobalIpv6.check(address, 'ipv6');
  }

  return false;
};

export interface PushDnsResolveOptions {
  readonly family?: LookupOptions['family'];
  readonly hints?: number;
}

export type PushDnsResolver = (
  hostname: string,
  options: PushDnsResolveOptions,
) => Promise<readonly LookupAddress[]>;

const systemResolver: PushDnsResolver = async (hostname, options) =>
  lookup(hostname, {
    all: true,
    order: 'verbatim',
    ...(options.family === undefined ? {} : { family: options.family }),
    ...(options.hints === undefined ? {} : { hints: options.hints }),
  });

const blockedAddressError = (): NodeJS.ErrnoException => {
  const error = new Error('Push endpoint address is not allowed.') as NodeJS.ErrnoException;
  error.code = BLOCKED_ADDRESS_ERROR_CODE;
  return error;
};

const lookupError = (error: unknown): NodeJS.ErrnoException => {
  if (error instanceof Error) {
    return error;
  }

  return new Error('Push endpoint DNS lookup failed.');
};

export const createRestrictedPushLookup =
  (resolveAll: PushDnsResolver = systemResolver): LookupFunction =>
  (hostname, options, callback): void => {
    void resolveAll(hostname, {
      ...(options.family === undefined ? {} : { family: options.family }),
      ...(options.hints === undefined ? {} : { hints: options.hints }),
    }).then(
      (addresses) => {
        const validAddresses = addresses.every(
          ({ address, family }) =>
            family === isIP(address) &&
            (family === 4 || family === 6) &&
            isPublicPushAddress(address),
        );

        if (addresses.length === 0 || !validAddresses) {
          callback(blockedAddressError(), '', 0);
          return;
        }

        if (options.all === true) {
          callback(null, [...addresses]);
          return;
        }

        const selected = addresses[0];

        if (selected === undefined) {
          callback(blockedAddressError(), '', 0);
          return;
        }

        callback(null, selected.address, selected.family);
      },
      (error: unknown) => callback(lookupError(error), '', 0),
    );
  };

export const createRestrictedPushAgent = (resolveAll: PushDnsResolver = systemResolver): Agent =>
  new Agent({
    keepAlive: false,
    lookup: createRestrictedPushLookup(resolveAll),
  });

export const isBlockedPushAddressError = (error: unknown): boolean =>
  typeof error === 'object' &&
  error !== null &&
  'code' in error &&
  error.code === BLOCKED_ADDRESS_ERROR_CODE;
