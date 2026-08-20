import type { HealthResponse } from '@kinetra/shared';

export const apiBaseUrl = (import.meta.env.VITE_API_URL ?? 'http://localhost:3000').replace(
  /\/$/u,
  '',
);

export const fetchHealth = async (signal: AbortSignal): Promise<HealthResponse> => {
  const response = await fetch(`${apiBaseUrl}/health`, {
    headers: {
      Accept: 'application/json',
    },
    signal,
  });

  if (!response.ok) {
    throw new Error(`Health request failed with status ${response.status}.`);
  }

  return (await response.json()) as HealthResponse;
};
