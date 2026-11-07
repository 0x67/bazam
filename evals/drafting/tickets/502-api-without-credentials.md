---
key: DEMO-502
kind: new
---

# DEMO-502: Partner API refuses requests without credentials

Partners call the API with an API key, with HTTP Basic credentials or with an OAuth2 bearer token. A request that carries none of them must be refused, so that nobody reads partner data anonymously.

**Acceptance criteria**

1. `GET /api/key/whoami` without an `X-Api-Key` header answers 401.
2. `GET /api/basic/whoami` without HTTP Basic credentials answers 401.
3. `GET /api/oauth/whoami` without a bearer token answers 401.
