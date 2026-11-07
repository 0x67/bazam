# Demo app

A small web app that the example project, the integration tests and the evals run against. It has email code sign-in delivered through Mailpit, TOTP, passkeys, a PIN step that confirms a transfer, four phone number forms, and API endpoints behind an API key, HTTP Basic, OAuth2 bearer tokens with refresh, a session cookie and HMAC signatures. State lives in memory and is lost on restart.

The server is Hono on Node with plain server-rendered HTML. Every link, button and visible input carries a `data-testid`.

**Start and stop**

1. From the repository root: `docker compose -f examples/demo-app/docker-compose.yml up -d`. Docker builds the app image from the root so the install uses the workspace lockfile.
2. Open the app at http://localhost:3300 and the Mailpit inbox at http://localhost:8325.
3. Stop with `docker compose -f examples/demo-app/docker-compose.yml down`.
4. To run the app outside Docker, start Mailpit (or any SMTP server) and run `pnpm --filter demo-app start`. Set `SMTP_HOST` and `SMTP_PORT` when it is not on `localhost:1025`.

**Ports and settings**

1. `DEMO_APP_PORT` (default `3300`): host port of the app. The compose file also derives `DEMO_ORIGIN` from it, because passkeys only work on the origin the browser sees.
2. `DEMO_MAILPIT_HTTP_PORT` (default `8325`): host port of the Mailpit web UI and API.
3. `DEMO_MAILPIT_SMTP_PORT` (default `1325`): host port of the Mailpit SMTP server.
4. `DEMO_TEST_HOOKS` (compose default `1`): mounts the test hooks. Any other value, or no value, leaves them out.
5. Inside the container the app reads `PORT` (default `3000`), `DEMO_ORIGIN` (default `http://localhost:<PORT>`), `SMTP_HOST` and `SMTP_PORT`.

**Mailpit**

1. The compose file pins `axllent/mailpit:v1.33.0`, the newest stable release on 2026-11-06. Dependabot proposes newer tags.
2. Sign-in mail goes to the address typed on `/login`, with the subject `Your sign-in code` and a body that holds one six digit code.
3. Mailpit v1.33.0 serves that mail through `GET /api/v1/search?query=to:"<address>"` (newest first) and `GET /api/v1/message/<ID>` (the body is in the `Text` field). The tests read it this way, and the `otp-mailpit` resolver should too.

**Pages**

1. `/login`: email form (`email`, `send-code`), the passkey button (`sign-in-passkey`, status in `passkey-status`) and a link to TOTP sign-in. When `email` is filled in, the passkey button allows only that account's passkeys; when it is empty, the browser offers any discoverable passkey.
2. `/login/verify`: the emailed code (`otp-input`, `verify-code`). A code works once and expires after five minutes.
3. `/login/totp`: email and TOTP code (`email`, `totp-code`, `sign-in-totp`).
4. `/dashboard`: the signed-in home (`dashboard`, `user-email`, `sign-out`).
5. `/account/totp`: TOTP enrollment. It shows the key in `totp-seed` and turns TOTP on with a valid code (`totp-code`, `enable-totp`). With test hooks on, every enrollment uses the fixed key below, so a test can know it in advance.
6. `/account/passkey`: adds a passkey (`register-passkey`, count in `passkey-count`).
7. `/transfer/confirm`: the PIN step (`pin-input`, `confirm-transfer`, result in `transfer-confirmed`). The PIN comes from the secret `DEMO_PIN` (value `2468`, set in an environment variable or the secrets file) through the `pin-secret` resolver, so no person types it.
8. `/profile/phone`: four forms that each post to `/profile/phone/<form>`, save one phone number and show it in E.164 in `<form>-saved` (`select-saved`, `search-saved`, `full-saved`, `local-saved`). The country list holds the United Kingdom, Indonesia and the United States.
   1. `select`: a native country select (`select-country`, options labelled `United Kingdom (+44)` with the value `GB`) beside a number field (`select-number`, `select-save`).
   2. `search`: a searchable country list (`search-country`, options such as `🇬🇧 +44`; typing `+44` or `44` works too) beside a number field (`search-number`, `search-save`).
   3. `full`: one field for the whole number with its country code, such as `+44 7700 900123` (`full-number`, `full-save`).
   4. `local`: a number field for the fixed country shown in `local-country`, the United Kingdom (`local-number`, `local-save`).

   The `select`, `search` and `local` forms take the national number with or without the trunk prefix (`07700 900123` or `7700 900123`). Every number field ignores spaces, dashes, dots and brackets.

Successful sign-ins set the `session` cookie, which lasts ten minutes. Pages that need a session redirect to `/login` with status 303.

**API endpoints**

1. `GET /api/key/whoami`: needs `X-Api-Key`.
2. `GET /api/basic/whoami`: needs HTTP Basic.
3. `POST /oauth/token`: form encoded, client authentication by HTTP Basic or by `client_id` and `client_secret` fields. `grant_type=client_credentials` returns `access_token`, `token_type`, `expires_in` (300 seconds) and `refresh_token`. `grant_type=refresh_token` swaps a refresh token for a new pair, and the old refresh token stops working.
4. `GET /api/oauth/whoami`: needs `Authorization: Bearer <access_token>`.
5. `GET /api/session/me`: needs the `session` cookie and returns `email`, `totpEnabled`, `passkeys` and `transfersConfirmed`.
6. `POST /auth/refresh`: needs the `session` cookie, sets a new one and ends the old one.
7. `POST /logout`: ends the session.
8. Any method on `/api/hmac/echo`: needs an HMAC signature and returns `keyId`, `method`, `path`, `query` and the body as text.
9. Passkey JSON endpoints used by `public/passkey.js`: `POST /account/passkey/options`, `POST /account/passkey`, `POST /login/passkey/options` and `POST /login/passkey`.

Requests without valid credentials get status 401.

**HMAC signatures**

1. The string to sign is `{method}\n{path}\n{query}\n{timestamp}\n{nonce}\n{bodySha256}`: the method in upper case, the URL path, the query string without `?` (empty when there is none), the timestamp, the nonce, and the lowercase hex SHA-256 of the raw body (of the empty string when there is no body).
2. The signature is the lowercase hex HMAC-SHA256 of that string with the key secret.
3. Send `X-Key-Id`, `X-Timestamp` (unix seconds), `X-Nonce` and `X-Signature`.
4. The server refuses a timestamp more than 30 seconds from its clock and a nonce it has already accepted. Its `Date` header lets a client check clock skew first.

**Demo credentials**

These values are public on purpose. They live in `src/config.ts`.

1. API key: `demo-api-key`.
2. HTTP Basic: user `demo`, password `demo-password`.
3. OAuth2 client: id `demo-client`, secret `demo-client-secret`.
4. HMAC key: id `demo-partner`, secret `demo-hmac-secret`.
5. PIN: `2468`.
6. TOTP key with test hooks on: `GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ` (base32 of the RFC 6238 test key `12345678901234567890`), SHA-1, 30 second steps, six digits. The app also accepts the codes of the previous and next step.

Any email address can sign in with a code; the first sign-in creates the account. Use addresses under `example.test`.

**Test hooks**

Mounted only when `DEMO_TEST_HOOKS=1`.

1. `GET /test/otp?recipient=<address>`: the pending sign-in code for that address as `{ "code": "123456" }`, or 404.
2. `GET /test/login?email=<address>`: signs the address in without a code, creating the account on first use, and answers 303 to `/dashboard` with the `session` cookie set. Answers 400 when `email` is not an address. The example project's session identities log in through it.
3. `POST /test/reset`: clears every account, session, token, passkey and pending code. Answers 204.

**Tests**

With the compose stack running, `pnpm --filter demo-app test` calls every endpoint with `fetch`. The tests read `DEMO_APP_PORT` and `DEMO_MAILPIT_HTTP_PORT` like the compose file does, and register passkeys with a software authenticator in `test/support/authenticator.ts`.

`test/example-project.test.ts` runs the CLI from its sources against the example project in `examples/`, which expects the default ports. Its browser run needs Playwright's Chromium: `pnpm --filter @bazam/driver-web exec playwright install chromium`.
