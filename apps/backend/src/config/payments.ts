// Defaults preserve the existing paid deployment. Disabling is always explicit.
export const parsePaymentsEnabled = (value: string | undefined): boolean => {
  if (value === undefined || value === 'true') return true;
  if (value === 'false') return false;
  throw new Error('PAYMENTS_ENABLED must be true or false.');
};
