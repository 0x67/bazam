---
key: DEMO-503
kind: new
---

# DEMO-503: Wrong sign-in code shows an error

When someone signs in with the code we email them and types a code that is not the one in the email, they should see why the sign-in did not work and be able to try again.

**Acceptance criteria**

1. On the code page, a code other than the emailed one shows the message "That code is wrong or has expired."
2. The person stays on the code page, with the code field there to try again.
