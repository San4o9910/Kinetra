// Defaults preserve the existing paid deployment. Disabling is always explicit.
export const parsePaymentsEnabled = (value: string | undefined): boolean => {
  if (value === undefined || value === 'true') return true;
  if (value === 'false') return false;
  throw new Error('PAYMENTS_ENABLED must be true or false.');
};

export const parseFreeBetaEnabled = (
  value: string | undefined,
  paymentsEnabled: boolean,
): boolean => {
  if (value === undefined || value === 'false') return false;
  if (value !== 'true') throw new Error('FREE_BETA_ENABLED must be true or false.');
  if (paymentsEnabled) throw new Error('FREE_BETA_ENABLED=true requires PAYMENTS_ENABLED=false.');
  return true;
};
