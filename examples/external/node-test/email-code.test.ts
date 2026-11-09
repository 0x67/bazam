/// <reference types="node" />
import assert from "node:assert/strict";
import { test } from "node:test";
import { requestChallenge } from "../../clients/ts/challenge-client.ts";

// Email code sign-ins against the demo app on Node's own test runner, run by runner demo-node-test:
//   bazam run --root examples --env demo --target node-test
// bazam maps each test in junit.xml to the case whose id its title holds in brackets.

const selected = (process.env["BAZAM_CASES"] ?? "").split(",").filter((id) => id !== "");

/** Runs every test outside bazam; under bazam, only the tests of the cases the run selected. */
function skip(id: string): string | false {
  return selected.length === 0 || selected.includes(id) ? false : "not in BAZAM_CASES";
}

// read inside a test, since a file that throws on load reports one test that maps to no case
function setting(name: "APP_URL" | "MAILPIT_URL"): string {
  const value = process.env[name];
  assert.ok(value, `${name} is not set; run this suite through bazam run --target node-test`);
  return value;
}

/** A new address per run; the app lowercases it, and a `--run` id may hold capitals. */
function newAddress(prefix: string): string {
  const runId = process.env["BAZAM_RUN_ID"] ?? String(Date.now());
  return `${prefix}-${runId}@example.test`.toLowerCase();
}

async function mailCode(appUrl: string, email: string): Promise<void> {
  const sent = await fetch(`${appUrl}/login`, {
    method: "POST",
    body: new URLSearchParams({ email }),
    redirect: "manual",
  });
  assert.equal(sent.status, 303);
  assert.equal(sent.headers.get("location"), `/login/verify?email=${encodeURIComponent(email)}`);
}

// the code stays out of assertions, whose actual and expected values the reporters write to junit.xml and stdout
async function mailedCode(caseId: string, email: string, signal: AbortSignal): Promise<string> {
  const answer = await requestChallenge(
    { kind: "otp-email", caseId, params: { recipient: email, url: setting("MAILPIT_URL") } },
    { signal },
  );
  assert.ok("value" in answer, "the challenge service answered without a code");
  return answer.value;
}

function verify(appUrl: string, email: string, code: string): Promise<Response> {
  return fetch(`${appUrl}/login/verify`, {
    method: "POST",
    body: new URLSearchParams({ email, code }),
    redirect: "manual",
  });
}

function sessionCookie(response: Response): string | undefined {
  return response.headers
    .getSetCookie()
    .map((cookie) => cookie.split(";", 1)[0] ?? "")
    .find((pair) => pair.startsWith("session="));
}

const SIGN_IN = "API-OTP-001";
void test(
  `[${SIGN_IN}] signs in with the code mailed to a new address`,
  { timeout: 60_000, skip: skip(SIGN_IN) },
  async (t) => {
    const appUrl = setting("APP_URL");
    const email = newAddress("otp-signin");
    await mailCode(appUrl, email);
    const signedIn = await verify(appUrl, email, await mailedCode(SIGN_IN, email, t.signal));
    assert.equal(signedIn.status, 303);
    assert.equal(signedIn.headers.get("location"), "/dashboard");
    const cookie = sessionCookie(signedIn);
    assert.ok(cookie, "the app set no session cookie");
    const me = await fetch(`${appUrl}/api/session/me`, { headers: { cookie } });
    assert.equal(me.status, 200);
    const body = (await me.json()) as { email?: unknown };
    assert.equal(body.email, email);
  },
);

const ONCE = "API-OTP-002";
void test(`[${ONCE}] accepts a mailed code only once`, { timeout: 60_000, skip: skip(ONCE) }, async (t) => {
  const appUrl = setting("APP_URL");
  const email = newAddress("otp-once");
  await mailCode(appUrl, email);
  const code = await mailedCode(ONCE, email, t.signal);
  const first = await verify(appUrl, email, code);
  assert.equal(first.status, 303);
  const second = await verify(appUrl, email, code);
  assert.equal(second.status, 401);
  assert.match(await second.text(), /That code is wrong or has expired\./);
});
