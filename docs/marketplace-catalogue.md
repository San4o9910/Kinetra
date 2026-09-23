# Marketplace catalogue foundation

This change introduces trainer storefronts and offer descriptions. It does not
implement checkout or change access to existing training content.

## Routes and ownership

- `/catalog`, `/coaches/:uuid` and `/offers/:uuid` are public. Authentication is
  optional, and signing in from an offer returns to that offer.
- `/trainer/marketplace` edits the authenticated active trainer's profile and
  offers. The backend obtains ownership from the verified principal.
- `/admin/marketplace` is restricted on the backend to existing trainer
  verification reviewers. A reviewer cannot approve their own publication.

Migration `020_marketplace_catalogue.sql` creates additive profile, offer and
publication-event tables. Existing students, private materials, nutrition,
invitations, assignments and single-trainer relationships are not migrated.

Drafts and public snapshots are separate. Saving a draft cannot change the
published price or description. Submission validates complete terms; publication
requires an explicit moderator decision for the current revision. Stale edits
and decisions fail with a conflict. Repeated draft saves and submissions do not
duplicate their effects. Pausing or suspending a storefront hides its offers.
Inactive trainer accounts are excluded from public reads.

The editor supports incomplete drafts, independent duplication, account-scoped
local recovery, and five steps covering format, contents, feedback, price and
conditions, then preview. Prices use integer kopecks. Public responses project
only published content; there are no seeded coaches, reviews or sales.

## Commercial limits

The trainer's old seat-package calculator is removed from the UI. The catalogue
does not add a mandatory platform subscription. Purchases are disabled in API
responses and UI, no checkout endpoint is added, and no commission is assumed.
An offer describes an intended service; it does not yet grant access to lessons,
nutrition, groups or bookings. Public samples in this version are text only.

## Verification and release

Run type checking, lint, frontend unit tests, the marketplace schema tests and
the production build. The mandatory PostgreSQL test validates ownership,
publication, revision conflicts, independent copies, public snapshot privacy,
literal search, suspension and audit events against the migrated database.

The browser scenario creates a storefront and a five-step offer, verifies the
private draft state, renders the published offer, tests filter reset and return
after login, and records 390 px and 1280 px screenshots. Its publication fixture
is for UI testing; PostgreSQL tests exercise real moderation logic. CI requires
both `KINETRA_MARKETPLACE_CATALOGUE_POSTGRES=PASS` and
`KINETRA_MARKETPLACE_CATALOGUE_BROWSER=PASS`. Test code existing in the repository
is not evidence that those scenarios have passed.

Before installation, require green CI, inspect the marketplace screenshot
artifact, qualify the image, then use the existing backup/restore and upgrade
release process. Do not enable payments or expand the pilot as part of this
change. The migration only adds tables, so application rollback may leave those
tables in place without dropping catalogue content.

## Follow-up scope

This is a foundation, not a complete marketplace. Independent relationships
with several trainers, the full navigation redesign, offer material linkage,
versioned purchase contracts, orders, payments, commissions, refunds, service
obligations, group workflows, bookings, assigned nutrition plans, attribution,
support and the pilot acceptance suite require subsequent implementation.
