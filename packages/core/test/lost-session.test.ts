import { rm } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vite-plus/test";
import { z } from "zod";
import { CredentialCache, defineAuthStrategy, Identities } from "../src/auth/index.ts";
import { BRAND } from "../src/brand.ts";
import type { Driver, DriverSession, StepContext, StepHandler } from "../src/driver/index.ts";
import { guardedHttp } from "../src/driver/http.ts";
import { RunValues } from "../src/env/index.ts";
import { definePlugin, PLUGIN_API_VERSION } from "../src/plugin/index.ts";
import { defaultRedactionRules, Redactor } from "../src/redact/index.ts";
import { CaseEvidence } from "../src/run/case-evidence.ts";
import { CaseRun, type RunScope } from "../src/run/case-run.ts";
import { CaseValues } from "../src/run/case-values.ts";
import { SessionLost } from "../src/run/outcome.ts";
import { FakeBrowserSession } from "./support/fake-browser.ts";
import { loadTestProject } from "./support/project.ts";

const ORIGIN = "https://shop.example.test";
const LOGIN_URL = `${ORIGIN}/login?next=%2Forders%3Ftoken%3Dfake-secret`;
const NO_QUERY = `${ORIGIN}/login`;

let accepted: Set<string>;
let issued: number;
let refreshable: boolean;
let loginFailure: Error | undefined;
// the credential each look step saw, and each time the land step ran
let events: string[];
// how many more times the land step throws SessionLost
let lands: number;
// the case under test, so a step can reload a credential as the runner does
let current: CaseRun | undefined;
// the next credential applied to a browser reloads the credential once more
let reloadAgain: boolean;

beforeEach(() => {
  accepted = new Set();
  issued = 0;
  refreshable = true;
  loginFailure = undefined;
  events = [];
  lands = 0;
  current = undefined;
  reloadAgain = false;
});

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

function issue(): { token: string } {
  issued += 1;
  const token = `fake-token-${issued}`;
  accepted.add(token);
  return { token };
}

function tokenStrategy(name: string, cacheable: boolean) {
  return defineAuthStrategy<object, { token: string }>({
    name,
    config: z.object({}),
    cacheable,
    acquire: async () => {
      if (loginFailure !== undefined) throw loginFailure;
      return issue();
    },
    probe: async (credential: { token: string }) => accepted.has(credential.token),
    canRefresh: () => refreshable,
    refresh: async () => issue(),
    apply: async (credential, target) => {
      if (target.kind === "browser")
        await target.session.setExtraHeaders({ authorization: `Bearer ${credential.token}` });
      if (reloadAgain) {
        reloadAgain = false;
        current?.reloadCredential("customer", "web");
      }
    },
    secrets: (credential) => [credential.token],
  });
}

/** A browser context whose page the test can send to the login page or to a 401. */
class WatchedContext extends FakeBrowserSession {
  readonly watchers: { pattern: string; listener: (url: string) => void }[] = [];
  readonly unauthorizedListeners: ((origin: string) => void)[] = [];

  onUnauthorized(listener: (origin: string) => void): () => void {
    this.unauthorizedListeners.push(listener);
    return () => {};
  }

  onSessionLost(pattern: string, listener: (url: string) => void): () => void {
    const watcher = { pattern, listener };
    this.watchers.push(watcher);
    return () => {
      this.watchers.splice(this.watchers.indexOf(watcher), 1);
    };
  }
}

async function watched(ctx: StepContext): Promise<WatchedContext> {
  const browser = await ctx.session.browserFor?.(ctx.identity ?? "");
  if (!(browser instanceof WatchedContext))
    throw new Error("the step runs without the identity's browser context");
  return browser;
}

const steps: readonly StepHandler[] = [
  {
    kind: "look",
    schema: z.unknown(),
    run: async (_payload, ctx) => {
      events.push(`look with ${(await watched(ctx)).extraHeaders["authorization"]}`);
    },
  },
  {
    kind: "expire",
    schema: z.unknown(),
    run: async () => {
      accepted.clear();
    },
  },
  // a redirect to the login page that the step does not notice itself
  {
    kind: "redirect",
    schema: z.unknown(),
    run: async (_payload, ctx) => {
      for (const { listener } of (await watched(ctx)).watchers) listener(LOGIN_URL);
    },
  },
  // the page is redirected to the login page, and the step sees it too
  {
    kind: "bounce",
    schema: z.unknown(),
    run: async (_payload, ctx) => {
      events.push("bounce");
      if (lands <= 0) return;
      lands -= 1;
      for (const { listener } of (await watched(ctx)).watchers) listener(LOGIN_URL);
      throw new SessionLost();
    },
  },
  // a 401 from the page
  {
    kind: "call",
    schema: z.unknown(),
    run: async (_payload, ctx) => {
      for (const listener of (await watched(ctx)).unauthorizedListeners) listener(ORIGIN);
    },
  },
  // the next login fails, as when the login page is down
  {
    kind: "break-login",
    schema: z.unknown(),
    run: async () => {
      loginFailure = new Error("the login page answered 503");
    },
  },
  // a credential reload that starts another while it applies, then a lost session
  {
    kind: "reload-and-land",
    schema: z.unknown(),
    run: async () => {
      events.push("land");
      reloadAgain = true;
      current?.reloadCredential("customer", "web");
      if (lands <= 0) return;
      lands -= 1;
      throw new SessionLost();
    },
  },
  {
    kind: "land",
    schema: z.unknown(),
    run: async () => {
      events.push("land");
      if (lands <= 0) return;
      lands -= 1;
      throw new SessionLost();
    },
  },
];

const driver: Driver = {
  name: "fake",
  surface: "web",
  probe: async () => new Set(["browser.login"]),
  launch: async () => {
    throw new Error("each case here gets its session from the test");
  },
  steps,
};

const config = {
  envs: { demo: { production: false, hosts: ["shop.example.test"] } },
  identities: {
    customer: {
      auth: { web: { strategy: "fake-token", with: {}, lostOn: { url: `${ORIGIN}/login*` } } },
    },
    courier: { auth: { web: { strategy: "fake-token" } } },
    guest: { auth: { web: { strategy: "fake-static", lostOn: { url: `${ORIGIN}/login*` } } } },
  },
  targets: { web: { driver: "fake" } },
};

function testCase(
  steps: readonly Record<string, unknown>[],
  tail: readonly Record<string, unknown>[] = [],
) {
  return {
    id: "SHOP-LOST-001",
    title: "case SHOP-LOST-001",
    stage: "acceptance",
    risk: "low",
    links: ["jira:DEMO-9"],
    targets: ["web"],
    steps,
    finally: tail,
  };
}

interface CaseRan {
  notes: string[];
  browser: WatchedContext | undefined;
}

/** Runs the case; a block or error it ends with is returned in `error`, with the notes it made. */
async function runCase(
  spec: Record<string, unknown>,
  identity = "customer",
): Promise<CaseRan & { error: unknown }> {
  const plugin = definePlugin({
    name: "test-lost-session",
    apiVersion: PLUGIN_API_VERSION,
    drivers: [driver],
    authStrategies: [tokenStrategy("fake-token", true), tokenStrategy("fake-static", false)],
  });
  const { root, project, registry } = await loadTestProject(
    { [BRAND.configFile]: config, "cases/shop/lost.yaml": { cases: [spec] } },
    [plugin],
  );
  roots.push(root);
  const env = project.config.envs["demo"]!;
  const redactor = new Redactor(defaultRedactionRules());
  const channel = { ask: async () => ({ kind: "timeout" as const }) };
  const identities = new Identities({
    env,
    configs: project.config.identities,
    fixtures: {},
    registry,
    cache: new CredentialCache(join(root, "credentials")),
    lockDir: join(root, "locks"),
    resolve: async (value) => value,
    redactor,
    log: () => {},
    projectRoot: root,
    channel,
    now: () => new Date(),
  });
  const scope: RunScope = {
    runId: "20261108-091500-3c4d",
    project,
    env,
    registry,
    redactor,
    signal: new AbortController().signal,
    identities,
    credentials: identities,
    http: guardedHttp({ env, redactor, log: () => {} }),
    channel,
    stateDir: join(root, BRAND.stateDir),
    secret: async (key) => {
      throw new Error(`no secret ${key} in this test`);
    },
    identityField: () => undefined,
    log: () => {},
  };
  const contexts = new Map<string, WatchedContext>();
  const session: DriverSession = {
    capabilities: new Set(["browser.login"]),
    browserFor: async (who) => {
      const context = contexts.get(who) ?? new WatchedContext();
      contexts.set(who, context);
      return context;
    },
    close: async () => {},
  };
  const evidence = new CaseEvidence(join(root, "runs"), "SHOP-LOST-001", redactor);
  const notes: string[] = [];
  evidence.note = (text) => {
    notes.push(text);
  };
  const loaded = project.cases[0]!;
  const run = new CaseRun(scope, {
    spec: loaded.spec,
    driver,
    session,
    evidence,
    runValues: new RunValues("20261108-091500-3c4d", new Date("2026-11-08T09:15:00Z"), 7).forCase(
      "SHOP-LOST-001",
    ),
    values: new CaseValues("SHOP-LOST-001", loaded.spec.title),
  });
  current = run;
  let error: unknown;
  await run.run().catch((caught: unknown) => {
    error = caught;
  });
  return { notes, browser: contexts.get(identity), error };
}

const as = { as: "customer" };

describe("CaseRun after a redirect to the login page", () => {
  it("recovers before the next step and names the redirect without its query", async () => {
    const { notes, error } = await runCase(
      testCase([
        { look: true, ...as },
        { expire: true },
        { redirect: true, ...as },
        { look: true, ...as },
      ]),
    );

    expect(error).toBeUndefined();
    expect(events).toEqual(["look with Bearer fake-token-1", "look with Bearer fake-token-2"]);
    expect(notes).toEqual([`refreshed customer's web credential after a redirect to ${NO_QUERY}`]);
  });

  it("subscribes only an identity whose surface sets lostOn", async () => {
    const { browser } = await runCase(testCase([{ look: true, as: "courier" }]), "courier");

    expect(browser?.watchers).toEqual([]);
  });

  it("stops watching once the case ends", async () => {
    const { browser } = await runCase(testCase([{ look: true, ...as }]));

    expect(browser?.watchers).toEqual([]);
  });

  it("notes a later redirect after the case's one recovery", async () => {
    const { notes } = await runCase(
      testCase([
        { look: true, ...as },
        { expire: true },
        { redirect: true, ...as },
        { redirect: true, ...as },
        { redirect: true, ...as },
      ]),
    );

    expect(notes).toEqual([
      `refreshed customer's web credential after a redirect to ${NO_QUERY}`,
      `another redirect to ${NO_QUERY} after this case's one recovery`,
    ]);
  });
});

describe("CaseRun when a step throws SessionLost", () => {
  it("runs the step again after refreshing and notes it", async () => {
    lands = 1;
    const { notes, error } = await runCase(
      testCase([{ look: true, ...as }, { expire: true }, { land: true, ...as }]),
    );

    expect(error).toBeUndefined();
    expect(events).toEqual(["look with Bearer fake-token-1", "land", "land"]);
    expect(notes).toEqual([
      `refreshed customer's web credential after step 3 (land) landed on the login page`,
      "step 3 (land) ran again after refreshing customer's web credential",
    ]);
  });

  it("says it logged in again when the credential cannot be refreshed", async () => {
    refreshable = false;
    lands = 1;
    const { notes } = await runCase(
      testCase([{ look: true, ...as }, { expire: true }, { land: true, ...as }]),
    );

    expect(notes).toContain("step 3 (land) ran again after logging in again as customer on web");
  });

  it("waits for the recovery a redirect started and starts no second one", async () => {
    lands = 1;
    const { notes } = await runCase(
      testCase([{ look: true, ...as }, { expire: true }, { bounce: true, ...as }]),
    );

    expect(events).toEqual(["look with Bearer fake-token-1", "bounce", "bounce"]);
    expect(notes).toEqual([
      `refreshed customer's web credential after a redirect to ${NO_QUERY}`,
      "step 3 (bounce) ran again after refreshing customer's web credential",
    ]);
  });

  it("blocks the case when the step lands on the login page again after the retry", async () => {
    lands = 2;
    const { error } = await runCase(
      testCase([{ look: true, ...as }, { expire: true }, { land: true, ...as }]),
    );

    expect(error).toMatchObject({
      name: "CaseBlocked",
      message: "step 3 (land) landed on the login page again after the session was recovered",
    });
  });

  it("blocks a step that acts as no identity", async () => {
    lands = 1;
    const { error } = await runCase(testCase([{ look: true, ...as }, { land: true }]));

    expect(error).toMatchObject({
      name: "CaseBlocked",
      message: "step 2 (land) landed on the login page, but it acts as no identity with web auth",
    });
  });

  it("blocks when the credential still passes its probe", async () => {
    lands = 1;
    const { error } = await runCase(
      testCase([
        { look: true, ...as },
        { land: true, ...as },
      ]),
    );

    expect(error).toMatchObject({
      message:
        "step 2 (land) landed on the login page, but the web credential of customer still passes its probe",
    });
  });

  it("blocks when the credential cannot be refreshed or logged in again", async () => {
    lands = 1;
    const { error, notes } = await runCase(
      testCase([{ look: true, as: "guest" }, { expire: true }, { land: true, as: "guest" }]),
    );

    expect(error).toMatchObject({
      message:
        "step 3 (land) landed on the login page, and the web credential of guest cannot be refreshed or logged in again",
    });
    expect(notes).toEqual([
      "step 3 (land) landed on the login page; the web credential of guest cannot be refreshed",
    ]);
  });

  it("ends blocked with the login's reason when logging in again fails", async () => {
    refreshable = false;
    lands = 1;
    const { error, notes } = await runCase(
      testCase([
        { look: true, ...as },
        { expire: true },
        { "break-login": true },
        { land: true, ...as },
      ]),
    );

    expect(error).toMatchObject({
      name: "CaseBlocked",
      message:
        "logging in again as customer on web after step 4 (land) landed on the login page failed: the login page answered 503",
    });
    expect(notes).toEqual([]);
  });

  it("blocks when the case's one recovery is spent", async () => {
    lands = 1;
    const { error, notes } = await runCase(
      testCase([
        { look: true, ...as },
        { expire: true },
        { redirect: true, ...as },
        { expire: true },
        { land: true, ...as },
      ]),
    );

    expect(error).toMatchObject({
      message:
        "step 5 (land) lost the web session of customer again after this case's one recovery",
    });
    expect(notes).toEqual([`refreshed customer's web credential after a redirect to ${NO_QUERY}`]);
  });

  it("starts the case's one recovery after a credential reload chains another", async () => {
    lands = 1;
    const { error, notes } = await runCase(
      testCase([{ look: true, ...as }, { expire: true }, { "reload-and-land": true, ...as }]),
    );

    expect(error).toBeUndefined();
    expect(events).toEqual(["look with Bearer fake-token-1", "land", "land"]);
    expect(notes).toEqual([
      "refreshed customer's web credential after step 3 (reload-and-land) landed on the login page",
      "step 3 (reload-and-land) ran again after refreshing customer's web credential",
    ]);
  });

  it("counts the recovery as the case's one, so a later 401 adds the usual note", async () => {
    lands = 1;
    const { notes } = await runCase(
      testCase([
        { look: true, ...as },
        { expire: true },
        { land: true, ...as },
        { call: true, ...as },
      ]),
    );

    expect(notes.at(-1)).toBe(`another 401 from ${ORIGIN} after this case's one recovery`);
  });

  it("recovers in a finally step, and a block there becomes a note", async () => {
    lands = 1;
    const recovered = await runCase(
      testCase([{ look: true, ...as }], [{ expire: true }, { land: true, ...as }]),
    );

    expect(recovered.error).toBeUndefined();
    expect(recovered.notes).toEqual([
      "refreshed customer's web credential after step 3 (land) landed on the login page",
      "step 3 (land) ran again after refreshing customer's web credential",
    ]);

    lands = 1;
    const blocked = await runCase(testCase([{ look: true, ...as }], [{ land: true, ...as }]));

    expect(blocked.error).toBeUndefined();
    expect(blocked.notes).toEqual([
      "finally step 2 (land) failed: step 2 (land) landed on the login page, but the web credential of customer still passes its probe",
    ]);
  });
});
