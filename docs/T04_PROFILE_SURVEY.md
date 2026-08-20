# T04 — Profile and survey

## Protected API

Both endpoints require an access JWT in the `Authorization: Bearer <token>` header. The server obtains the user ID exclusively from the verified JWT subject and never from request JSON.

### `GET /api/v1/me`

Returns the authenticated user's profile, the current survey version, and subscription status.

### `PUT /api/v1/me/survey`

Creates a new immutable survey version and marks the previous version as non-current. When the user's status is `survey_pending`, the first valid submission advances it to `onboarding_pending`. Editing a survey later does not move the user backwards in onboarding.

The accepted JSON fields are:

- `gender`
- `age_range`
- `goal`
- `injuries`
- `injuries_detail` when `other` is selected
- `experience`

Validation is performed with Zod and reinforced by PostgreSQL constraints. The database rejects unknown injury values, empty or duplicate injury selections, `none` combined with another value, and an absent or overlong `injuries_detail` for `other`.

## Secure browser session

The frontend keeps the short-lived access token only in JavaScript memory. It does not write access tokens to `localStorage` or another persistent browser store. The rotating refresh token remains in the backend-issued HttpOnly cookie.

The API client:

1. includes credentials for login, refresh, logout, and protected requests;
2. restores a session through `POST /api/v1/auth/refresh` after a page reload;
3. retries a protected request once after a `401` by rotating the refresh session;
4. deduplicates simultaneous refresh attempts;
5. clears the in-memory access token on logout or an invalid refresh session.

## Frontend routes

After authentication the frontend calls `GET /api/v1/me` and uses server state as the source of truth:

- `survey_pending` → `/survey`
- `onboarding_pending` → `/onboarding`
- `base_lessons` → `/base-lessons`
- `active` → `/`

Settings use `/settings`, and survey editing uses `/settings/survey`. The browser back button works through the History API. The settings screen reopens the wizard with the latest current survey prefilled.

Network failures and expired sessions are intentionally different states: a connection problem shows a retry screen, while an invalid session returns the user to `/login`.

## Verification

From the repository root:

```bash
npm run verify:structure
npm run typecheck
npm run lint
npm run test
npm run build
```

`npm run test` includes:

- backend auth/profile tests;
- PostgreSQL survey-versioning and constraint tests when `DATABASE_URL` is present;
- pure frontend tests for survey validation and server-driven routing;
- a real headless Chrome acceptance flow covering login, refresh-and-retry, all five survey steps, `none` exclusivity, `other` details, save, edit prefill, browser back, reload restoration, status routes, logout, and absence of a persisted access token.
