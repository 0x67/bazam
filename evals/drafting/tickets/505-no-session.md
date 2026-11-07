---
key: DEMO-505
kind: extend
case: AUTH-SESSION-001
---

# DEMO-505: No account data without a session

A customer must only ever see their own account. That includes someone who is not signed in at all: they see no account.

**Acceptance criteria**

1. `GET /api/session/me` without a session cookie answers 401.
2. Opening the dashboard without a session shows the sign-in page.
