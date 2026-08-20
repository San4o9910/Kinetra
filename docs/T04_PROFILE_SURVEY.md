# T04 — Profile and survey

## Protected API

Both endpoints require an access JWT in the `Authorization: Bearer <token>` header.
The server obtains the user ID exclusively from the verified JWT.

### `GET /api/v1/me`

Returns the authenticated user's profile, the current survey version, and subscription status.

### `PUT /api/v1/me/survey`

Creates a new immutable survey version and marks the previous version as non-current.
When the user's status is `survey_pending`, the first valid submission advances it to
`onboarding_pending`. Editing a survey later does not move the user backwards in onboarding.

The accepted JSON fields are:

- `gender`
- `age_range`
- `goal`
- `injuries`
- `injuries_detail` when `other` is selected
- `experience`

Validation is performed with Zod and reinforced by PostgreSQL constraints.

## Frontend routing

After authentication the frontend calls `GET /api/v1/me` and routes by server state:

- `survey_pending` → survey wizard
- `onboarding_pending` → T05 placeholder
- `base_lessons` → T06 placeholder
- `active` → T08 placeholder

The settings screen can reopen the wizard with the current survey prefilled.
