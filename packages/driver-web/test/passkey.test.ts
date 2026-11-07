import { readdir, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import {
  builtinKinds,
  resolveChallenge,
  type ChallengeKindSpec,
  type ChallengeRequest,
  type ResolverContext,
} from "@bazam/core/challenge";
import { guardedHttp } from "@bazam/core/driver";
import type { Environment } from "@bazam/core/env";
import { Redactor, defaultRedactionRules } from "@bazam/core/redact";
import type { EvidenceStore } from "@bazam/core/result";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import type { WebSession } from "../src/driver.ts";
import { virtualPasskeyResolver } from "../src/passkey.ts";
import {
  demoEnv,
  ENGINES,
  html,
  launch,
  newEvidence,
  runSteps,
  startSite,
  stepContext,
  tempDir,
  type Site,
} from "./support/site.ts";

vi.setConfig({ testTimeout: 30_000, hookTimeout: 30_000 });

const CASE_ID = "AUTH-PASSKEY-001";
const IDENTITY = "customer";

// The page talks to WebAuthn the way an app does and shows what happened; the relying party is the page's host.
const PASSKEY_PAGE = `
<button onclick="register()">Register passkey</button>
<button onclick="signIn()">Sign in with passkey</button>
<p data-testid="status"></p>
<script>
  const bytes = (text) => new TextEncoder().encode(text);
  const show = (text) => { document.querySelector("[data-testid=status]").textContent = text; };
  async function register() {
    const credential = await navigator.credentials.create({ publicKey: {
      challenge: bytes("fake-challenge-register"),
      rp: { id: location.hostname, name: "Demo" },
      user: { id: bytes("user-1"), name: "ops@example.test", displayName: "Ops" },
      pubKeyCredParams: [{ type: "public-key", alg: -7 }],
      authenticatorSelection: { residentKey: "required" },
    } }).catch((error) => error);
    show(credential instanceof Error ? "failed " + credential.name : "registered " + credential.id);
  }
  async function signIn() {
    const credential = await navigator.credentials.get({ publicKey: { challenge: bytes("fake-challenge-sign-in"), rpId: location.hostname } }).catch((error) => error);
    show(credential instanceof Error ? "failed " + credential.name : "signed in " + credential.id);
  }
</script>
`;

const passkeyKind: ChallengeKindSpec = builtinKinds.find((kind) => kind.name === "passkey")!;

describe.each(ENGINES)("virtualPasskeyResolver on %s", (engine) => {
  let site: Site;
  let env: Environment;
  let root: string;
  let redactor: Redactor;
  const sessions: WebSession[] = [];

  beforeAll(async () => {
    site = await startSite({ "/": html(PASSKEY_PAGE) });
    env = demoEnv();
  });

  afterAll(() => site.close());

  beforeEach(async () => {
    root = await tempDir();
    redactor = new Redactor(defaultRedactionRules());
  });

  afterEach(async () => {
    for (const session of sessions.splice(0))
      await session.close({ status: "pass", evidence: newEvidence(root, CASE_ID) });
    await rm(root, { recursive: true, force: true });
  });

  async function openPage(): Promise<{ session: WebSession; evidence: EvidenceStore }> {
    const session = await launch(engine, { env, runDir: join(root, "runs"), redactor });
    sessions.push(session);
    const evidence = newEvidence(join(root, "runs"), CASE_ID);
    await runSteps(stepContext(session, { env, evidence, root, identity: IDENTITY }), [{ open: `${site.origin}/` }]);
    return { session, evidence };
  }

  function resolverContext(session: WebSession): ResolverContext {
    return {
      env,
      http: guardedHttp({ env, redactor, log: () => {} }),
      session,
      channel: { ask: async () => ({ kind: "timeout" }) },
      prompt: { runId: "20261107-090000-ab12", timeoutMs: 1_000 },
      stateDir: join(root, "state"),
      secrets: async (key) => {
        throw new Error(`no secret ${key} in this test`);
      },
      now: () => new Date(),
      signal: new AbortController().signal,
    };
  }

  /** Arms the resolver, taps the button that starts the ceremony, and returns what the page then shows. */
  async function challenge(
    session: WebSession,
    evidence: EvidenceStore,
    button: string,
    step: number,
  ): Promise<{ resolver: string; status: string }> {
    const request: ChallengeRequest = { kind: "passkey", caseId: CASE_ID, identity: IDENTITY, step, params: {} };
    const ctx = stepContext(session, { env, evidence, root, identity: IDENTITY });
    const resolved = await resolveChallenge(
      request,
      passkeyKind,
      [virtualPasskeyResolver],
      resolverContext(session),
      () => runSteps(ctx, [{ tap: { role: "button", name: button } }]),
    );
    const page = await (await session.contextFor(IDENTITY)).page();
    await page.getByTestId("status").filter({ hasText: /\S/ }).waitFor();
    return { resolver: resolved.resolver, status: (await page.getByTestId("status").textContent()) ?? "" };
  }

  async function storedPasskeys(): Promise<{ id: string; privateKey: string; signCount: number }[]> {
    const dir = join(root, "state", "credentials");
    const [file] = await readdir(dir);
    return JSON.parse(await readFile(join(dir, file!), "utf8")).credential;
  }

  it("registers a passkey, keeps it in the credential cache and signs in with it in a later session", async () => {
    const first = await openPage();
    const registered = await challenge(first.session, first.evidence, "Register passkey", 2);

    expect(registered.resolver).toBe("passkey-virtual");
    expect(registered.status).toMatch(/^registered \S+$/);
    const [passkey] = await storedPasskeys();
    expect(registered.status).toBe(`registered ${passkey!.id}`);
    expect(redactor.text(`key ${passkey!.privateKey}`)).toBe("key [redacted]");

    const later = await openPage();
    const signedIn = await challenge(later.session, later.evidence, "Sign in with passkey", 2);

    expect(signedIn.status).toBe(`signed in ${passkey!.id}`);
    expect((await storedPasskeys()).map((stored) => stored.signCount)).toEqual([1]);
  });

  it("keeps the identity's passkeys when its storage state loads again", async () => {
    const { session, evidence } = await openPage();
    const registered = await challenge(session, evidence, "Register passkey", 2);

    await (await session.browserFor(IDENTITY)).loadStorageState({ cookies: [], origins: [] });
    // straight to the page, so the resolver cannot seed the passkey again from the cache
    await runSteps(stepContext(session, { env, evidence, root, identity: IDENTITY }), [
      { tap: { role: "button", name: "Sign in with passkey" } },
      { wait: { for: { css: "[data-testid=status]:not(:empty)" } } },
    ]);

    const page = await (await session.contextFor(IDENTITY)).page();
    expect(await page.getByTestId("status").textContent()).toBe(registered.status.replace("registered", "signed in"));
  });
});
