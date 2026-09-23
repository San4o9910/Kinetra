import { isDeepStrictEqual } from 'node:util';
import type { Pool, PoolClient } from 'pg';
import type {
  MarketCatalogue,
  MarketEntityKind,
  MarketDraft,
  MarketOffer,
  MarketOfferInput,
  MarketProfile,
  MarketProfileInput,
  MarketReviewItem,
} from '@kinetra/shared';
import { type TrainingService, trainingError, trainingId } from '../training/service.js';
import {
  marketProfileSchema,
  marketOfferSchema,
  marketProfileDraftSchema,
  marketOfferDraftSchema,
  marketRevisionSchema,
  marketReviewSchema,
  marketQuerySchema,
} from './schema.js';
import { z } from 'zod';

const tables = { profile: 'marketplace_profiles', offer: 'marketplace_offers' } as const;
const profilePublic = `SELECT p.id,p.published,
 (SELECT avg(r.score)::float8 FROM trainer_quality_reviews r WHERE r.trainer_id=p.id) rating,
 (SELECT count(*)::int FROM trainer_quality_reviews r WHERE r.trainer_id=p.id) review_count
 FROM marketplace_profiles p JOIN trainer_profiles t ON t.user_id=p.id
 WHERE p.is_listed AND p.published IS NOT NULL AND t.is_active`;
const offerPublic = `SELECT o.id,o.trainer_id,o.published,p.published->>'display_name' trainer_name
 FROM marketplace_offers o JOIN marketplace_profiles p ON p.id=o.trainer_id
 JOIN trainer_profiles t ON t.user_id=p.id
 WHERE o.is_listed AND o.published IS NOT NULL AND p.is_listed AND p.published IS NOT NULL AND t.is_active`;
const profileRow = (r: {
  id: string;
  published: MarketProfileInput;
  rating: number | null;
  review_count: number;
}): MarketProfile => ({ ...r.published, id: r.id, rating: r.rating, review_count: r.review_count });
const offerRow = (r: {
  id: string;
  trainer_id: string;
  published: MarketOfferInput;
  trainer_name: string;
}): MarketOffer => ({
  ...r.published,
  id: r.id,
  trainer_id: r.trainer_id,
  trainer_name: r.trainer_name,
});
type Draft = MarketDraft<MarketProfileInput | MarketOfferInput>;

export class MarketplaceService {
  public constructor(private readonly training: TrainingService) {}
  public async catalogue(query: unknown): Promise<MarketCatalogue> {
    const parsed = marketQuerySchema.safeParse(query);
    if (!parsed.success) trainingError(400, 'INVALID_FILTERS', 'Проверьте фильтры каталога.');
    const v = parsed.data;
    // Position search is literal: '%' and '_' never become wildcard searches.
    const params = [
      v.q,
      v.discipline ?? null,
      v.kind ?? null,
      v.level ?? null,
      v.period ?? null,
      (v.page - 1) * 24,
    ];
    const offerFilter = ` AND ($1='' OR position(lower($1) in lower(concat_ws(' ',o.published->>'title',o.published->>'summary',p.published->>'display_name')))>0)
      AND ($2::text IS NULL OR o.published->>'discipline'=$2)
      AND ($3::text IS NULL OR o.published->>'kind'=$3)
      AND ($4::text IS NULL OR o.published->>'level' IN ($4,'all'))
      AND ($5::text IS NULL OR o.published->>'payment_period'=$5)`;
    const offers = await this.training.pool.query(
      `${offerPublic}${offerFilter} ORDER BY o.published_at DESC,o.id LIMIT 25 OFFSET $6`,
      params,
    );
    const trainers = await this.training.pool.query(
      `${profilePublic}
      AND ($1='' OR position(lower($1) in lower(concat_ws(' ',p.published->>'display_name',p.published->>'headline')))>0)
      AND ($2::text IS NULL OR p.published->'disciplines' ? $2)
      AND (($3::text IS NULL AND $4::text IS NULL AND $5::text IS NULL) OR EXISTS (
        SELECT 1 FROM marketplace_offers o WHERE o.trainer_id=p.id AND o.is_listed AND o.published IS NOT NULL
          AND ($2::text IS NULL OR o.published->>'discipline'=$2)
          AND ($3::text IS NULL OR o.published->>'kind'=$3)
          AND ($4::text IS NULL OR o.published->>'level' IN ($4,'all'))
          AND ($5::text IS NULL OR o.published->>'payment_period'=$5)))
      ORDER BY p.published_at DESC,p.id LIMIT 25 OFFSET $6`,
      params,
    );
    const disciplines = await this.training.pool
      .query(`SELECT DISTINCT jsonb_array_elements_text(p.published->'disciplines') discipline
      FROM marketplace_profiles p JOIN trainer_profiles t ON t.user_id=p.id WHERE p.is_listed AND p.published IS NOT NULL AND t.is_active ORDER BY discipline`);
    return {
      trainers: trainers.rows.slice(0, 24).map(profileRow),
      offers: offers.rows.slice(0, 24).map(offerRow),
      disciplines: disciplines.rows.map((r) => r.discipline),
      page: v.page,
      page_size: 24,
      has_more: trainers.rows.length > 24 || offers.rows.length > 24,
      purchases_enabled: false,
    };
  }
  public async profile(id: string) {
    trainingId(id);
    const r = await this.training.pool.query(`${profilePublic} AND p.id=$1`, [id]);
    if (!r.rows[0])
      trainingError(404, 'PROFILE_UNAVAILABLE', 'Витрина пока не опубликована или недоступна.');
    const offers = await this.training.pool.query(
      `${offerPublic} AND o.trainer_id=$1 ORDER BY o.published_at DESC,o.id LIMIT 100`,
      [id],
    );
    return {
      profile: profileRow(r.rows[0]),
      offers: offers.rows.map(offerRow),
      purchases_enabled: false as const,
    };
  }
  public async offer(id: string) {
    const r = await this.training.pool.query(`${offerPublic} AND o.id=$1`, [trainingId(id)]);
    if (!r.rows[0])
      trainingError(404, 'OFFER_UNAVAILABLE', 'Предложение пока не опубликовано или недоступно.');
    return { offer: offerRow(r.rows[0]), purchases_enabled: false as const };
  }
  public async workspace(user: string) {
    await this.training.trainer(this.training.pool, user);
    const profile = await this.training.pool.query(
      'SELECT * FROM marketplace_profiles WHERE id=$1',
      [user],
    );
    const offers = await this.training.pool.query(
      'SELECT * FROM marketplace_offers WHERE trainer_id=$1 ORDER BY updated_at DESC,id LIMIT 100',
      [user],
    );
    return {
      profile: (profile.rows[0] ?? null) as MarketDraft<MarketProfileInput> | null,
      offers: offers.rows as MarketDraft<MarketOfferInput>[],
      purchases_enabled: false as const,
      commission_percent: null,
    };
  }
  private async owned(
    db: PoolClient,
    user: string,
    kind: MarketEntityKind,
    id: string,
  ): Promise<Draft> {
    await this.training.trainer(db, user);
    const r = await db.query(
      `SELECT * FROM ${tables[kind]} WHERE id=$1 AND trainer_id=$2 FOR UPDATE`,
      [trainingId(id), user],
    );
    if (!r.rows[0]) trainingError(404, 'DRAFT_UNAVAILABLE', 'Черновик недоступен.');
    return r.rows[0] as Draft;
  }
  private revision(row: Draft, revision: number) {
    if (row.revision !== revision)
      trainingError(
        409,
        'REVISION_CONFLICT',
        'Версия уже изменилась. Сохраните свои правки и загрузите свежую версию.',
      );
  }
  public async save(
    user: string,
    kind: MarketEntityKind,
    id: string,
    body: unknown,
  ): Promise<Draft> {
    trainingId(id);
    const envelope = z
      .object({ revision: z.number().int().min(0), draft: z.unknown() })
      .strict()
      .safeParse(body);
    if (!envelope.success)
      trainingError(400, 'INVALID_DRAFT', 'Проверьте версию и поля черновика.');
    const parsed = (
      kind === 'profile' ? marketProfileDraftSchema : marketOfferDraftSchema
    ).safeParse(envelope.data.draft);
    if (!parsed.success)
      trainingError(
        400,
        'INVALID_DRAFT',
        parsed.error.issues
          .map((v) => v.message)
          .slice(0, 3)
          .join(' '),
      );
    if (kind === 'profile' && id !== user)
      trainingError(404, 'DRAFT_UNAVAILABLE', 'Черновик недоступен.');
    return this.training.transaction(async (db) => {
      await this.training.trainer(db, user);
      await db.query("SELECT pg_advisory_xact_lock(hashtext('marketplace-author'),hashtext($1))", [
        user,
      ]);
      const found = await db.query(`SELECT * FROM ${tables[kind]} WHERE id=$1 FOR UPDATE`, [id]);
      const row = found.rows[0] as Draft | undefined;
      if (row && row.trainer_id !== user)
        trainingError(404, 'DRAFT_UNAVAILABLE', 'Черновик недоступен.');
      if (row?.review_state === 'suspended')
        trainingError(
          409,
          'PUBLICATION_SUSPENDED',
          'Публикация приостановлена. Обратитесь к модератору.',
        );
      if (
        row &&
        row.revision === envelope.data.revision + 1 &&
        row.review_state === 'draft' &&
        isDeepStrictEqual(row.draft, parsed.data)
      )
        return row;
      if (row) this.revision(row, envelope.data.revision);
      else if (envelope.data.revision !== 0)
        trainingError(409, 'REVISION_CONFLICT', 'Черновик не найден. Обновите список.');
      if (!row && kind === 'offer') {
        const count = await db.query(
          'SELECT count(*)::int n FROM marketplace_offers WHERE trainer_id=$1',
          [user],
        );
        if (count.rows[0].n >= 100)
          trainingError(409, 'OFFER_LIMIT', 'Достигнут лимит 100 предложений.');
      }
      const result = row
        ? await db.query(
            `UPDATE ${tables[kind]} SET draft=$2,revision=revision+1,review_state='draft',review_note='',updated_at=now() WHERE id=$1 RETURNING *`,
            [id, JSON.stringify(parsed.data)],
          )
        : await db.query(
            `INSERT INTO ${tables[kind]}(id,trainer_id,draft) VALUES($1,$2,$3) RETURNING *`,
            [id, user, JSON.stringify(parsed.data)],
          );
      return result.rows[0] as Draft;
    });
  }
  private async event(
    db: PoolClient,
    kind: MarketEntityKind,
    id: string,
    user: string,
    action: string,
    revision: number,
    note = '',
  ) {
    await db.query(
      'INSERT INTO marketplace_publication_events(entity,entity_id,actor_id,action,revision,note) VALUES($1,$2,$3,$4,$5,$6)',
      [kind, id, user, action, revision, note],
    );
  }
  public async submit(user: string, kind: MarketEntityKind, id: string, body: unknown) {
    const p = marketRevisionSchema.safeParse(body);
    if (!p.success) trainingError(400, 'INVALID_REVISION', 'Укажите текущую версию.');
    return this.training.transaction(async (db) => {
      const row = await this.owned(db, user, kind, id);
      this.revision(row, p.data.revision);
      const valid = (kind === 'profile' ? marketProfileSchema : marketOfferSchema).safeParse(
        row.draft,
      );
      if (!valid.success)
        trainingError(
          400,
          'INCOMPLETE_PUBLICATION',
          'Перед отправкой заполните все условия: описание, состав, сроки, стоимость, требования и отмену. Для сопровождения нужны срок ответа и число мест.',
        );
      if (row.review_state === 'suspended')
        trainingError(409, 'PUBLICATION_SUSPENDED', 'Обратитесь к модератору.');
      if (row.review_state === 'pending') return { saved: true };
      await db.query(
        `UPDATE ${tables[kind]} SET review_state='pending',updated_at=now() WHERE id=$1`,
        [id],
      );
      await this.event(db, kind, id, user, 'submit', row.revision);
      return { saved: true };
    });
  }
  public async pause(user: string, kind: MarketEntityKind, id: string, body: unknown) {
    const p = marketRevisionSchema.safeParse(body);
    if (!p.success) trainingError(400, 'INVALID_REVISION', 'Укажите текущую версию.');
    return this.training.transaction(async (db) => {
      const row = await this.owned(db, user, kind, id);
      this.revision(row, p.data.revision);
      if (row.is_listed) {
        await db.query(
          `UPDATE ${tables[kind]} SET is_listed=false,revision=revision+1,updated_at=now() WHERE id=$1`,
          [id],
        );
        await this.event(db, kind, id, user, 'pause', row.revision);
      }
      return { saved: true };
    });
  }
  private async reviewer(db: Pool | PoolClient, user: string) {
    const r = await db.query(
      'SELECT user_id FROM trainer_verification_reviewers WHERE user_id=$1 FOR SHARE',
      [user],
    );
    if (!r.rowCount)
      trainingError(403, 'REVIEWER_REQUIRED', 'Проверка доступна только модератору.');
  }
  public async queue(user: string): Promise<{ items: MarketReviewItem[] }> {
    await this.reviewer(this.training.pool, user);
    const p = await this.training.pool.query(
      "SELECT *, 'profile'::text entity FROM marketplace_profiles WHERE review_state IN ('pending','suspended') OR published IS NOT NULL ORDER BY (review_state='pending') DESC,(review_state='suspended') DESC,updated_at DESC,id LIMIT 100",
    );
    const o = await this.training.pool.query(
      "SELECT *, 'offer'::text entity FROM marketplace_offers WHERE review_state IN ('pending','suspended') OR published IS NOT NULL ORDER BY (review_state='pending') DESC,(review_state='suspended') DESC,updated_at DESC,id LIMIT 100",
    );
    return { items: [...p.rows, ...o.rows] as MarketReviewItem[] };
  }
  public async review(user: string, kind: MarketEntityKind, id: string, body: unknown) {
    const p = marketReviewSchema.safeParse(body);
    if (!p.success)
      trainingError(400, 'INVALID_REVIEW', 'Укажите решение, причину и текущую версию.');
    return this.training.transaction(async (db) => {
      await this.reviewer(db, user);
      const r = await db.query(`SELECT * FROM ${tables[kind]} WHERE id=$1 FOR UPDATE`, [
        trainingId(id),
      ]);
      const row = r.rows[0] as Draft | undefined;
      if (!row) trainingError(404, 'DRAFT_UNAVAILABLE', 'Публикация недоступна.');
      if (row.trainer_id === user)
        trainingError(403, 'SELF_REVIEW', 'Нельзя одобрять собственные публикации.');
      this.revision(row, p.data.revision);
      if (p.data.action === 'approve') {
        if (row.review_state !== 'pending')
          trainingError(409, 'NOT_PENDING', 'Сначала автор отправляет версию на проверку.');
        await this.training.trainer(db, row.trainer_id);
        if (kind === 'offer') {
          const profile = await db.query(
            'SELECT id FROM marketplace_profiles WHERE id=$1 AND is_listed AND published IS NOT NULL FOR SHARE',
            [row.trainer_id],
          );
          if (!profile.rowCount)
            trainingError(409, 'PROFILE_REQUIRED', 'Сначала опубликуйте витрину тренера.');
        }
        await db.query(
          `UPDATE ${tables[kind]} SET published=draft,is_listed=true,published_at=now(),review_state='approved',review_note=$2,revision=revision+1,updated_at=now() WHERE id=$1`,
          [id, p.data.note],
        );
      } else {
        await db.query(
          `UPDATE ${tables[kind]} SET review_state=$2,review_note=$3,is_listed=CASE WHEN $2='suspended' THEN false ELSE is_listed END,revision=revision+1,updated_at=now() WHERE id=$1`,
          [id, p.data.action === 'suspend' ? 'suspended' : 'changes_requested', p.data.note],
        );
      }
      await this.event(db, kind, id, user, p.data.action, row.revision, p.data.note);
      return { saved: true };
    });
  }
}
