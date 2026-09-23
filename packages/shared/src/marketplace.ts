export const MARKET_DISCIPLINES = ['swimming', 'strength', 'fitness'] as const;
export type MarketDiscipline = (typeof MARKET_DISCIPLINES)[number];
export const MARKET_DISCIPLINE_LABELS: Record<MarketDiscipline, string> = {
  swimming: 'Плавание',
  strength: 'Силовые тренировки',
  fitness: 'Общая физическая подготовка',
};
export const MARKET_OFFER_LABELS = {
  program: 'Готовая программа',
  coaching: 'Личное сопровождение',
  club: 'Группа или клуб',
  lesson: 'Занятие или пакет',
} as const;
export type MarketOfferKind = keyof typeof MARKET_OFFER_LABELS;
export interface MarketProfileInput {
  display_name: string;
  headline: string;
  bio: string;
  city: string;
  approach: string;
  disciplines: MarketDiscipline[];
  languages: string[];
  faq: { question: string; answer: string }[];
}
export interface MarketOfferInput {
  title: string;
  summary: string;
  description: string;
  discipline: MarketDiscipline;
  kind: MarketOfferKind;
  level: 'beginner' | 'intermediate' | 'advanced' | 'all';
  price_kopecks: number;
  payment_period: 'once' | 'month';
  access_days: number;
  start_policy: string;
  includes: string;
  requirements: string;
  feedback: string;
  nutrition: 'none' | 'general' | 'personal';
  response_hours: number | null;
  video_reviews: number;
  meetings: number;
  capacity: number | null;
  application_required: boolean;
  cancellation_terms: string;
  sample_text: string;
}
export type MarketEntityKind = 'profile' | 'offer';
export type MarketReviewState =
  'draft' | 'pending' | 'approved' | 'changes_requested' | 'suspended';
export interface MarketDraft<T> {
  id: string;
  trainer_id: string;
  draft: T;
  published: T | null;
  revision: number;
  review_state: MarketReviewState;
  review_note: string;
  is_listed: boolean;
  updated_at: string;
  published_at: string | null;
}
export interface MarketProfile extends MarketProfileInput {
  id: string;
  rating: number | null;
  review_count: number;
}
export interface MarketOffer extends MarketOfferInput {
  id: string;
  trainer_id: string;
  trainer_name: string;
}
export interface MarketCatalogue {
  trainers: MarketProfile[];
  offers: MarketOffer[];
  disciplines: MarketDiscipline[];
  page: number;
  page_size: number;
  has_more: boolean;
  purchases_enabled: false;
}
export type MarketReviewItem =
  | (MarketDraft<MarketProfileInput> & { entity: 'profile' })
  | (MarketDraft<MarketOfferInput> & { entity: 'offer' });
export const marketPrice = (offer: Pick<MarketOfferInput, 'price_kopecks' | 'payment_period'>) =>
  `${(offer.price_kopecks / 100).toLocaleString('ru-RU', { maximumFractionDigits: 2 })} ₽${offer.payment_period === 'month' ? ' / месяц' : ' разово'}`;
