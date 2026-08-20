import { domainToASCII } from 'node:url';

const EMAIL_MAX_LENGTH = 320;
const EMAIL_LOCAL_PART_MAX_LENGTH = 64;
const PHONE_PATTERN = /^\+[1-9]\d{7,14}$/u;

export type NormalizedIdentifier =
  | { readonly kind: 'email'; readonly value: string }
  | { readonly kind: 'phone'; readonly value: string };

export const normalizeEmail = (rawValue: string): string | null => {
  const value = rawValue.normalize('NFKC').trim();
  const atIndex = value.lastIndexOf('@');

  if (atIndex <= 0 || atIndex !== value.indexOf('@')) {
    return null;
  }

  const localPart = value.slice(0, atIndex).toLowerCase();
  const rawDomain = value.slice(atIndex + 1).toLowerCase();
  const domain = domainToASCII(rawDomain);
  const normalized = `${localPart}@${domain}`;

  if (
    localPart.length === 0 ||
    localPart.length > EMAIL_LOCAL_PART_MAX_LENGTH ||
    domain.length === 0 ||
    normalized.length > EMAIL_MAX_LENGTH ||
    /\s/u.test(normalized) ||
    localPart.startsWith('.') ||
    localPart.endsWith('.') ||
    localPart.includes('..')
  ) {
    return null;
  }

  const domainLabels = domain.split('.');
  const validDomain = domainLabels.every(
    (label) =>
      label.length > 0 &&
      label.length <= 63 &&
      /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/u.test(label),
  );

  if (!validDomain || !/^[^\s@]+$/u.test(localPart)) {
    return null;
  }

  return normalized;
};

export const normalizePhone = (rawValue: string): string | null => {
  let value = rawValue.normalize('NFKC').trim();

  if (value.startsWith('00')) {
    value = `+${value.slice(2)}`;
  }

  value = value.replace(/[\s().-]/gu, '');

  if (!PHONE_PATTERN.test(value)) {
    return null;
  }

  return value;
};

export const normalizeIdentifier = (
  rawValue: string,
  phoneLoginEnabled: boolean,
): NormalizedIdentifier | null => {
  const value = rawValue.trim();

  if (value.includes('@')) {
    const email = normalizeEmail(value);
    return email === null ? null : { kind: 'email', value: email };
  }

  if (!phoneLoginEnabled) {
    return null;
  }

  const phone = normalizePhone(value);
  return phone === null ? null : { kind: 'phone', value: phone };
};
