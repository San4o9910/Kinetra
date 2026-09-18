# Lesson sharing and Kinetra intro — 18 September 2026

Accepted on the existing server 9069403 at https://80.68.156.131/.
The owner authorized shared/personal lessons, selected/all-student assignment, the logo correction and a slower drop-to-wordmark-to-split-K animation. No paid resource was created. Payments remain disabled; the researched trial/discount proposal is not an active billing timer.

## Source and qualification

- PR 27: source `c57cc5d54e87bb2468a9d84630557d4f52ec57d1`, merged as `badac80ca01fa84e9ba246b763f018f3b6277d3d` onto `cd6bd3c853caaea4a262e7821776461cb691f504`.
- Exact-head CI 35386025095, merge-ref CI 35386029688 (tested merge `0f177341e8c3028b6e60ac422ffd534825cc5da3`) and merged push CI 35386594657: every job and step passed. Backend 272 tests, frontend 205 tests, all mandatory browser scenarios.
- Focused visual run 35386086927 / job 105733227750, source c57cc5d, control `2f2e61bfa11a38dae04c41fa58311c945c21a448`: six synthetic mobile animation frames inspected, with the final bright split-K checked. Keyboard skip, reduced-motion bypass, both themes' contrast and mobile/desktop overflow passed.
- Fresh read-only host inspection 35385118179, control `afa38e9e83355af7293711b6d092587fd8f50811`: prior accepted containers healthy, 17 migrations, expected persistent media and owner reviewer preserved.
- Image qualification 35387096909, control `ebd35bef379db1f089a41f65abb986ac29a1c0ea`: all steps passed, including non-root media conversion, frontend static assets, Trivy HIGH/CRITICAL/secrets and independent upstream CPE coverage under the existing bounded disposition.
- Image evidence artifact 10564725994: `sha256:45c3437e22cf3b7056ab3b9101ca4953095b212b22b309e141c16ad88f1ed536`.
- Prior image attempt 35386634588 stopped before compilation because its package-identity helper still pinned the previous approved source. The helper and workflow hash were updated to the new approved source; package ownership/visibility and all other checks were retained. The failed attempt was not used as release evidence.

## Delivered behavior

Trainers can create shared videos or personal videos bound to one owned student. Shared ready lessons can be assigned to selected students or all current nonarchived students, including pending invitations. This is a current-roster snapshot, not automatic access for future students. Personal videos cannot be used in another student's program or copied template.

Students can open assigned lessons independently of a full program, resume position and mark completion. Trainers see progress separately for each recipient. Reassignment preserves results; revocation removes the standalone assignment access. A separate published-program grant remains valid and is explained in the interface. Signed media access checks current ownership and grants on every request.

The trainer header now has a correctly sized contrasting K mark. Attention cards use actual theme tokens, fixing unreadable light cards. The video launch intro lasts seven seconds: falling orange drop, impact/ripple, bounce/ball, drawn KINETRA wordmark, gathered K and diagonal split. Skip is keyboard accessible; reduced-motion settings bypass the animation. Pause/resume does not replay it. App shell cache is v10.

Market research is in the application branch at `docs/pricing-research-ru-2026-09-18.md`. Official published prices are distinguished from actual willingness to pay. Proposed base prices 700/1200/1800 and discounted 420/720/1080 are pilot hypotheses. The proposed 14-day trial begins on first approved login; three paid periods receive 40% off. Neither billing nor an expiring access timer was activated.

## Installation and acceptance

Upgrade 35387448821, control `1e0bbd81827f99671bed73643714d7141f2c6096`: PASS_UPGRADED, every workflow step passed.

- Backend: `ghcr.io/san4o9910/kinetra-backend@sha256:469b2f69df8b88bdb959b0cbf482cc143cd557b45562c59babd9d4f58e974c9c`; container `87a27082c82830b6fbf3274588deca6601e9600882918cfeb89608000d027ea4`.
- Frontend: `ghcr.io/san4o9910/kinetra-frontend@sha256:472fab3ec4a647aae64e35736e359421be59c1cd912cc00ef0fc5a95550b9ae9`; container `62b0e25dce70b319e47e8b871426c65df06caaab11bcc5a798bac31aae333c0f`.
- PostgreSQL `a6d4870c61fae621ba44e772a11d5ef2a551e32944e6cc0487bd484c124ebad1` and Caddy were not restarted.
- Backup `/srv/kinetra-stage/lesson-sharing-release-c57cc5d54e87-35387448821/database.dump`, 218970 bytes, SHA-256 `c287187c978982c3c237b1e11ce2e63fa439411e918527b422d52b8c6ef1776e`. Restoration proved before additive migration 018; previous 17 migration checksums preserved. Final ledger 18. Rollback not needed.
- Existing programs, users, reviewer membership, private media files/configuration, six-character password minimum, text chat and opt-in reminders preserved.
- Ephemeral SSH key 778565 removed from guest and provider account; local key files removed.
- Public HTTPS, real assets, login and simplified registration passed anonymous browser acceptance at 1440x1000 and 390x844, with no horizontal overflow or uncaught browser errors. Trainer data/media routes require authentication. Authenticated functional tests ran on isolated fixtures; no real user was impersonated and no production test account or notification was created.

Retained upgrade artifact 10564981105: `sha256:32148be031091c477007574487a7990f3d9173bc82b6e970a51e7463c48304d9`.
Retained external browser artifact 10564616426: `sha256:95a7c249779ba2cf8e933fef875bbc08d2c7286717503eb57fcd53e172e26eb6`.
