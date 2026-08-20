# T03 Content Model

T03 adds the PostgreSQL content, program, subscription, progress, metrics, and achievement model for Kinetra.

## Migration

`apps/backend/migrations/002_content.sql` is applied by the existing `npm run db:migrate` command after `001_auth.sql`.

It creates:

- `videos`
- `program_weeks`
- `program_days`
- `subscriptions`
- `video_progress`
- `workout_completions`
- `weekly_metrics`
- `achievements`
- `user_achievements`

The migration includes foreign keys, range and enum checks, uniqueness rules, query indexes, and `updated_at` triggers where required.

## Seed

Run from the repository root:

```bash
npm run db:seed
```

The seed is transactional and idempotent. It upserts 12 weeks, 84 program days, 7 base lessons, 84 workout placeholders, and 5 initial achievements.

## Verification

With PostgreSQL available and migrations applied:

```bash
npm run db:seed
npm run db:seed
npm run db:verify-content
```

The second seed run confirms repeatability. The verifier checks table presence, constraints, indexes, schedule integrity, record counts, and rejection of invalid values.
