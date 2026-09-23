import assert from 'node:assert/strict';
import { test } from 'node:test';
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { MarketplaceService } from '../src/marketplace/service.js';
import { TrainingService } from '../src/training/service.js';
import { HttpError } from '../src/auth/errors.js';
const databaseUrl = process.env.DATABASE_URL;
if (process.env.KINETRA_REQUIRE_POSTGRES_TEST === 'true' && !databaseUrl)
  throw new Error('DATABASE_URL required');
const denies = (code: string) => (e: unknown) => e instanceof HttpError && e.code === code;
test(
  'marketplace publication: private drafts, revision review, independent copies and suspended trainer access',
  { skip: !databaseUrl },
  async () => {
    const pool = new pg.Pool({ connectionString: databaseUrl, max: 8 }),
      service = new MarketplaceService(new TrainingService(pool, false));
    const trainer = randomUUID(),
      other = randomUUID(),
      reviewer = randomUUID(),
      viewer = randomUUID(),
      offer = randomUUID(),
      copy = randomUUID();
    const users = [trainer, other, reviewer, viewer];
    const profile = {
      display_name: 'Мария',
      headline: 'Тренер по плаванию',
      bio: 'Обучение взрослых',
      city: 'Ростов-на-Дону',
      approach: 'Поэтапные занятия',
      disciplines: ['swimming'],
      languages: ['Русский'],
      faq: [],
    };
    const input = {
      title: 'Основы кроля',
      summary: 'Четыре недели техники',
      description: 'Описание программы',
      discipline: 'swimming',
      kind: 'program',
      level: 'beginner',
      price_kopecks: 350000,
      payment_period: 'once',
      access_days: 30,
      start_policy: 'После назначения',
      includes: 'Программа на месяц',
      requirements: 'Бассейн со спасателем, умение плавать',
      feedback: 'Без личной обратной связи',
      nutrition: 'none',
      response_hours: null,
      video_reviews: 0,
      meetings: 0,
      capacity: null,
      application_required: false,
      cancellation_terms: 'Обращение в поддержку',
      sample_text: 'Четыре отрезка по 25 м',
    };
    try {
      for (const user of users)
        await pool.query(
          "INSERT INTO users(id,email,password_hash,onboarding_status) VALUES($1,$2,$3,'active')",
          [
            user,
            `market-${user}@example.test`,
            '$2b$10$abcdefghijklmnopqrstuv12345678901234567890123456789012',
          ],
        );
      for (const user of [trainer, other])
        await pool.query("INSERT INTO trainer_profiles(user_id,display_name) VALUES($1,'Тренер')", [
          user,
        ]);
      await pool.query('INSERT INTO trainer_verification_reviewers(user_id) VALUES($1)', [
        reviewer,
      ]);
      await assert.rejects(service.workspace(viewer), denies('TRAINER_REQUIRED'));
      await assert.rejects(service.queue(trainer), denies('REVIEWER_REQUIRED'));
      await service.save(trainer, 'profile', trainer, { draft: profile, revision: 0 });
      await assert.rejects(service.profile(trainer), denies('PROFILE_UNAVAILABLE'));
      await service.submit(trainer, 'profile', trainer, { revision: 1 });
      await service.review(reviewer, 'profile', trainer, {
        revision: 1,
        action: 'approve',
        note: '',
      });
      assert.equal((await service.profile(trainer)).profile.display_name, 'Мария');
      await service.save(trainer, 'offer', offer, { draft: input, revision: 0 });
      await assert.rejects(service.offer(offer), denies('OFFER_UNAVAILABLE'));
      await assert.rejects(
        service.save(other, 'offer', offer, { draft: input, revision: 1 }),
        denies('DRAFT_UNAVAILABLE'),
      );
      await service.submit(trainer, 'offer', offer, { revision: 1 });
      await assert.rejects(
        service.review(viewer, 'offer', offer, { revision: 1, action: 'approve', note: '' }),
        denies('REVIEWER_REQUIRED'),
      );
      await pool.query('INSERT INTO trainer_verification_reviewers(user_id) VALUES($1)', [trainer]);
      await assert.rejects(
        service.review(trainer, 'offer', offer, { revision: 1, action: 'approve', note: '' }),
        denies('SELF_REVIEW'),
      );
      await service.review(reviewer, 'offer', offer, { revision: 1, action: 'approve', note: '' });
      assert.equal((await service.offer(offer)).offer.price_kopecks, 350000);
      const edited = { ...input, title: 'Новая версия', price_kopecks: 400000 };
      const saved = await service.save(trainer, 'offer', offer, { draft: edited, revision: 2 });
      assert.equal(saved.revision, 3);
      assert.equal(
        (await service.offer(offer)).offer.title,
        'Основы кроля',
        'Draft never replaces the approved public snapshot',
      );
      assert.ok(
        (await service.queue(reviewer)).items.some((item) => item.id === offer),
        'Moderators can suspend a public offer while its next version is still a draft',
      );
      assert.equal('draft' in (await service.offer(offer)).offer, false);
      assert.equal('review_note' in (await service.offer(offer)).offer, false);
      assert.equal(
        (await service.save(trainer, 'offer', offer, { draft: edited, revision: 2 })).revision,
        3,
        'Retried save is idempotent',
      );
      await assert.rejects(
        service.save(trainer, 'offer', offer, {
          draft: { ...edited, title: 'Stale' },
          revision: 2,
        }),
        denies('REVISION_CONFLICT'),
      );
      await service.submit(trainer, 'offer', offer, { revision: 3 });
      await service.submit(trainer, 'offer', offer, { revision: 3 });
      assert.equal(
        (
          await pool.query(
            "SELECT count(*)::int n FROM marketplace_publication_events WHERE entity_id=$1 AND action='submit' AND revision=3",
            [offer],
          )
        ).rows[0].n,
        1,
        'Retried submission does not duplicate its publication event',
      );
      await assert.rejects(
        service.review(reviewer, 'offer', offer, { revision: 2, action: 'approve', note: '' }),
        denies('REVISION_CONFLICT'),
      );
      await service.review(reviewer, 'offer', offer, {
        revision: 3,
        action: 'request_changes',
        note: 'Уточните состав',
      });
      assert.equal((await service.offer(offer)).offer.title, 'Основы кроля');
      await service.save(trainer, 'offer', copy, { draft: edited, revision: 0 });
      assert.equal((await service.workspace(trainer)).offers.length, 2);
      assert.equal(
        (await service.profile(trainer)).offers.length,
        1,
        'Independent copies are private',
      );
      const listing = await service.catalogue({
        discipline: 'swimming',
        kind: 'program',
        period: 'once',
        q: 'Основы',
      });
      assert.ok(listing.offers.some((o) => o.id === offer));
      assert.equal(listing.purchases_enabled, false);
      assert.equal(
        (await service.catalogue({ q: '%' })).offers.some((o) => o.id === offer),
        false,
        'Search wildcard is literal',
      );
      assert.equal(
        (await service.catalogue({ kind: 'coaching' })).offers.some((o) => o.id === offer),
        false,
      );
      await service.pause(trainer, 'profile', trainer, { revision: 2 });
      await assert.rejects(service.offer(offer), denies('OFFER_UNAVAILABLE'));
      await service.submit(trainer, 'profile', trainer, { revision: 3 });
      await service.review(reviewer, 'profile', trainer, {
        revision: 3,
        action: 'approve',
        note: '',
      });
      await service.review(reviewer, 'offer', offer, {
        revision: 4,
        action: 'suspend',
        note: 'Проверка условий',
      });
      await assert.rejects(
        service.save(trainer, 'offer', offer, { draft: input, revision: 5 }),
        denies('PUBLICATION_SUSPENDED'),
      );
      await assert.rejects(
        service.submit(trainer, 'offer', offer, { revision: 5 }),
        denies('PUBLICATION_SUSPENDED'),
      );
      await assert.rejects(service.offer(offer), denies('OFFER_UNAVAILABLE'));
      await pool.query('UPDATE trainer_profiles SET is_active=false WHERE user_id=$1', [trainer]);
      await assert.rejects(service.profile(trainer), denies('PROFILE_UNAVAILABLE'));
      assert.ok(
        (
          await pool.query('SELECT id FROM marketplace_publication_events WHERE entity_id=$1', [
            offer,
          ])
        ).rowCount! >= 4,
      );
      console.log('KINETRA_MARKETPLACE_CATALOGUE_POSTGRES=PASS');
    } finally {
      await pool.query(
        'DELETE FROM marketplace_publication_events WHERE actor_id=ANY($1::uuid[])',
        [users],
      );
      await pool.query('DELETE FROM users WHERE id=ANY($1::uuid[])', [users]);
      await pool.end();
    }
  },
);
