// A test client that is not a case: it asks the challenge service for the email code of a sign-in it starts
// itself, the way a test in another framework would. Run it under the challenge service from the repository root:
//   bazam exec --root examples --env demo -- node examples/clients/otp-client.mjs
// It exits 0 once the service returns a code, and 1 otherwise. It never prints the code.

import { randomUUID } from "node:crypto";

const appUrl = `http://localhost:${process.env.DEMO_APP_PORT ?? "3300"}`;
const mailpitUrl = `http://localhost:${process.env.DEMO_MAILPIT_HTTP_PORT ?? "8325"}`;

const serviceUrl = process.env.BAZAM_CHALLENGE_URL;
const token = process.env.BAZAM_CHALLENGE_TOKEN;
if (!serviceUrl || !token) {
  console.error(
    "BAZAM_CHALLENGE_URL and BAZAM_CHALLENGE_TOKEN are not set; run this client under the challenge service",
  );
  process.exit(1);
}

const recipient = `client-${randomUUID().slice(0, 8)}@example.test`;

// the service skips arm, so the client sends the code itself before it asks
const login = await fetch(`${appUrl}/login`, {
  method: "POST",
  body: new URLSearchParams({ email: recipient }),
  redirect: "manual",
});
if (login.status !== 303) {
  console.error(`POST /login answered ${login.status}, so no code was sent`);
  process.exit(1);
}

// resolving against the path also works when the variable holds the service's base URL
const response = await fetch(new URL("/challenge", serviceUrl), {
  method: "POST",
  headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
  body: JSON.stringify({ kind: "otp-email", caseId: "otp-client", params: { recipient, url: mailpitUrl } }),
});
const answer = await response.json().catch(() => ({}));
if (response.status !== 200 || typeof answer.value !== "string" || answer.value === "") {
  console.error(
    `the challenge service answered ${response.status}${answer.error ? `: ${answer.error}` : " with no code"}`,
  );
  process.exit(1);
}
console.log(`got a ${answer.value.length}-character code for ${recipient}`);
