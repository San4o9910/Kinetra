# SMTP preparation checkpoint — 2026-09-10

The owner has Yandex and Gmail mailboxes. Yandex is selected for initial Kinetra
authentication emails. Application commit `73b665065e00a5b375e90f701373b3e0856a0386`
adds direct SMTP delivery; the former requirement for a separate compatible
webhook is now an alternative configuration, not the chosen launch path.

The dormant application caller supplies reviewed constants `smtp`, `yandex`,
`https://80.68.156.131` and two step-local repository secrets:
`AUTH_TOKEN_DELIVERY_SMTP_USERNAME` and `AUTH_TOKEN_DELIVERY_SMTP_PASSWORD`.
The password is a Mail app password. No credentials were received or checked
against a real provider in this work segment. Never place them in logs or artifacts.

SMTP and webhook configuration are mutually exclusive. The existing webhook
tests remain. The API alone receives provider inputs; subsequent caller phases
reject them. Raw-file serialization guards, fixed server identity, hourly billing,
2,000 RUB budget, disabled payments and approved free beta are preserved.

The control helper integration passed 127 offline tests, with independent review
of the provider/caller paths and every dependent hash. Application validation
includes real Nodemailer against an offline SMTP peer. These are not live mail,
TLS, network-port or delivery acceptance results. Fresh source CI runs are
`34535162371` (head) and `34535166746` (PR). Root verified both complete runs,
all six jobs/steps and exact checkout identities; each test job passed 258 backend
and 203 frontend tests with zero skips and all mandatory PostgreSQL 17/S3/browser
markers. Merge commit is `2f5d388dea92ed4994131d0b5e77734189de026c`.
The earlier image run `34531345462` targets the previous application commit and
cannot qualify this SMTP candidate. The image-only concurrency group now cancels
superseded builds when a new reviewed candidate is published. Deployment
concurrency and every successful-evidence requirement are unchanged.

Timeweb documents default blocking of port 465 on new servers and a control-panel
unblock option. No supported public API route for this specific provider restriction
was verified in the public API/CLI/SDK references. Actual status on server 9069403
is unknown; ordinary guest firewall changes are not a substitute for provider
unblocking. No support request, control-panel mutation, SMTP authentication,
email, database initialization, application startup or HTTPS activation occurred.

Owner instructions and current official sources are in application
`docs/YANDEX_MAIL_SETUP.md`. The password may take 2–3 hours to activate according to
Yandex. Image qualification, needed provider inputs/network access and the
remaining launch phases still need completion. Existing continuous approval
remains in force; no new blanket deployment approval is required.
