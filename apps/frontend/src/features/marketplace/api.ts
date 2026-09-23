import type {
  MarketCatalogue,
  MarketProfile,
  MarketOffer,
  MarketProfileInput,
  MarketOfferInput,
  MarketDraft,
  MarketEntityKind,
  MarketReviewItem,
} from '@kinetra/shared';
import { apiBaseUrl, trainingRequest } from '../../lib/api';
const call = <T>(path: string, method = 'GET', body?: unknown) =>
  trainingRequest<T>(`/marketplace${path}`, {
    method,
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
async function publicGet<T>(path: string, signal?: AbortSignal): Promise<T> {
  const response = await fetch(`${apiBaseUrl}/api/v1/marketplace${path}`, {
    credentials: 'omit',
    signal: signal ?? null,
    cache: 'no-store',
  });
  const value = await response.json();
  if (!response.ok)
    throw new Error(value?.error?.message ?? 'Не удалось открыть каталог. Повторите попытку.');
  return value as T;
}
export const marketplaceApi = {
  catalogue: (query: string, signal?: AbortSignal) =>
    publicGet<MarketCatalogue>(`/?${query}`, signal),
  profile: (id: string, signal?: AbortSignal) =>
    publicGet<{ profile: MarketProfile; offers: MarketOffer[] }>(`/coaches/${id}`, signal),
  offer: (id: string, signal?: AbortSignal) =>
    publicGet<{ offer: MarketOffer }>(`/offers/${id}`, signal),
  workspace: () =>
    call<{
      profile: MarketDraft<MarketProfileInput> | null;
      offers: MarketDraft<MarketOfferInput>[];
    }>('/workspace'),
  saveProfile: (draft: MarketProfileInput, revision: number) =>
    call<MarketDraft<MarketProfileInput>>('/profile', 'PUT', { draft, revision }),
  saveOffer: (id: string, draft: MarketOfferInput, revision: number) =>
    call<MarketDraft<MarketOfferInput>>(`/offers/${id}`, 'PUT', { draft, revision }),
  submit: (kind: MarketEntityKind, id: string, revision: number) =>
    call(`/${kind === 'profile' ? 'profile' : `offers/${id}`}/submit`, 'POST', { revision }),
  pause: (kind: MarketEntityKind, id: string, revision: number) =>
    call(`/${kind === 'profile' ? 'profile' : `offers/${id}`}/pause`, 'POST', { revision }),
  queue: () => call<{ items: MarketReviewItem[] }>('/review'),
  review: (
    kind: MarketEntityKind,
    id: string,
    revision: number,
    action: 'approve' | 'request_changes' | 'suspend',
    note: string,
  ) => call(`/review/${kind}/${id}`, 'POST', { revision, action, note }),
};
