import { AsyncLocalStorage } from "node:async_hooks";
import { rm } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
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
import { FakeBrowserSession } from "./support/fake-browser.ts";
import { loadTestProject } from "./support/project.ts";

const RUN_ID = "20261108-091500-3c4d";
const ORIGIN = "https://shop.example.test";

// the case each callback runs for, set by the test around each case
const als = new AsyncLocalStorage<string>();

// tokens the fake service takes; every token issued is taken until a step expires them
let accepted: Set<string>;
let issued: number;
let refreshable: boolean;
let refreshDelayMs: number;
let refreshFailure: Error | undefined;
// what a new login throws, once a step has broken it
let loginFailure: Error | undefined;
// what the probe throws for a token the service no longer takes
let probeFailure: Error | undefined;
// what the steps and the strategies did, in order
let events: string[];
// each token the strategy probed, once when it was issued and then after a 401
let probed: string[];
// the case each 401 callback started in, before the listener runs
let callbacks: (string | undefined)[];
// the case.log lines, each after the case it was logged in
let lines: string[];
// how long a browser credential takes to apply, and how many have been applied
let applyDelayMs: number;
let applied: number;
// the notes of the case that ran last, also when it failed
let lastNotes: string[];
// the case that runs, for steps that reach into it
let current: CaseRun | undefined;

beforeEach(() => {
  accepted = new Set();
  issued = 0;
  refreshable = true;
  refreshDelayMs = 0;
  refreshFailure = undefined;
  loginFailure = undefined;
  probeFailure = undefined;
  events = [];
  probed = [];
  callbacks = [];
  lines = [];
  applyDelayMs = 0;
  applied = 0;
  lastNotes = [];
  current = undefined;
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

async function probe(token: string): Promise<boolean> {
  probed.push(token);
  if (accepted.has(token)) return true;
  if (probeFailure !== undefined) throw probeFailure;
  return false;
}

function tokenStrategy(name: string, options: { probe: boolean; cacheable?: boolean }) {
  return defineAuthStrategy<object, { token: string }>({
    name,
    config: z.object({}),
    cacheable: options.cacheable ?? true,
    acquire: async () => {
      if (loginFailure !== undefined) throw loginFailure;
      return issue();
    },
    ...(options.probe
      ? { probe: async (credential: { token: string }) => probe(credential.token) }
      : {}),
    canRefresh: () => refreshable,
    refresh: async () => {
      events.push(`refresh starts in ${als.getStore()}`);
      await sleep(refreshDelayMs);
      if (refreshFailure !== undefined) throw refreshFailure;
      events.push("refresh ends");
      return issue();
    },
    apply: async (credential, target) => {
      if (target.kind !== "browser") return;
      await sleep(applyDelayMs);
      await target.session.setExtraHeaders({ authorization: `Bearer ${credential.token}` });
      applied += 1;
    },
    secrets: (credential) => [credential.token],
  });
}

type Launched = ReturnType<typeof AsyncLocalStorage.snapshot>;

/** A context of a pooled browser, which calls its 401 listeners in the async context where the browser launched, as Playwright does. */
class PooledContext extends FakeBrowserSession {
  readonly #launched: Launched;
  readonly #listeners = new Set<(origin: string) => void>();

  constructor(launched: Launched) {
    super();
    this.#launched = launched;
  }

  onUnauthorized(listener: (origin: string) => void): () => void {
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  }

  /** The page got a 401 from `ORIGIN`. */
  unauthorized(): void {
    for (const listener of this.#listeners) {
      this.#launched(() => {
        callbacks.push(als.getStore());
        listener(ORIGIN);
      });
    }
  }
}

async function pooledContext(ctx: StepContext): Promise<PooledContext> {
  const browser = await ctx.session.browserFor?.(ctx.identity ?? "");
  if (!(browser instanceof PooledContext))
    throw new Error("the step runs without the identity's browser context");
  return browser;
}

const steps: readonly StepHandler[] = [
  {
    kind: "look",
    schema: z.unknown(),
    run: async (_payload, ctx) => {
      events.push(`look with ${(await pooledContext(ctx)).extraHeaders["authorization"]}`);
    },
  },
  // the service stops taking every token it issued so far
  {
    kind: "expire",
    schema: z.unknown(),
    run: async () => {
      accepted.clear();
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
  // the page gets a 401 and the step fails on its own
  {
    kind: "call-and-crash",
    schema: z.unknown(),
    run: async (_payload, ctx) => {
      (await pooledContext(ctx)).unauthorized();
      throw new Error("the page shows the login screen");
    },
  },
  // the case's credential is loaded into its browser context again after this long
  {
    kind: "reload-later",
    schema: z.number().int().positive(),
    run: async (ms) => {
      setTimeout(() => current?.reloadCredential("customer", "web"), ms as number);
    },
  },
  // the page gets this many 401s at once
  {
    kind: "call",
    schema: z.number().int().positive(),
    run: async (times, ctx) => {
      const browser = await pooledContext(ctx);
      for (let call = 0; call < (times as number); call += 1) browser.unauthorized();
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
    customer: { auth: { web: { strategy: "fake-token", refreshEveryMs: 60_000 } } },
    courier: { auth: { web: { strategy: "fake-unprobed" } } },
    guest: { auth: { web: { strategy: "fake-static" } } },
  },
  targets: { web: { driver: "fake" } },
};

function testCase(
  id: string,
  caseSteps: readonly Record<string, unknown>[],
): Record<string, unknown> {
  return {
    id,
    title: `case ${id}`,
    stage: "acceptance",
    risk: "low",
    links: ["jira:DEMO-9"],
    targets: ["web"],
    steps: caseSteps,
  };
}

interface CaseRan {
  /** Grows with each note the case adds, even after it ran. */
  notes: string[];
  /** The case's browser context for the identity. */
  browser: (identity: string) => PooledContext | undefined;
}

/**
 * Loads a project with `cases` and returns a function that runs one of them in a new session, inside
 * `als.run(<case id>)`. The cases share one run: its identities, and a browser pool the first case launches.
 */
async function startRun(
  cases: readonly Record<string, unknown>[],
): Promise<(caseId: string) => Promise<CaseRan>> {
  const plugin = definePlugin({
    name: "test-reauth",
    apiVersion: PLUGIN_API_VERSION,
    drivers: [driver],
    authStrategies: [
      tokenStrategy("fake-token", { probe: true }),
      tokenStrategy("fake-unprobed", { probe: false }),
      tokenStrategy("fake-static", { probe: true, cacheable: false }),
    ],
  });
  const { root, project, registry } = await loadTestProject(
    { [BRAND.configFile]: config, "cases/shop/reauth.yaml": { cases } },
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
    runId: RUN_ID,
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
    log: (line) => lines.push(`${als.getStore()}: ${line}`),
  };
  const runValues = new RunValues(RUN_ID, new Date("2026-11-08T09:15:00Z"), 7);
  let launched: Launched | undefined;
  return async (caseId) => {
    const loaded = project.cases.find(({ spec }) => spec.id === caseId);
    if (loaded === undefined) throw new Error(`the test project has no case ${caseId}`);
    const contexts = new Map<string, PooledContext>();
    const session: DriverSession = {
      capabilities: new Set(["browser.login"]),
      browserFor: async (identity) => {
        // the first case to use the pool launches its browser
        launched ??= AsyncLocalStorage.snapshot();
        const context = contexts.get(identity) ?? new PooledContext(launched);
        contexts.set(identity, context);
        return context;
      },
      close: async () => {},
    };
    const evidence = new CaseEvidence(join(root, "runs"), caseId, redactor);
    const notes: string[] = [];
    vi.spyOn(evidence, "note").mockImplementation((text) => {
      notes.push(text);
    });
    const run = new CaseRun(scope, {
      spec: loaded.spec,
      driver,
      session,
      evidence,
      runValues: runValues.forCase(caseId),
      values: new CaseValues(caseId, loaded.spec.title),
    });
    lastNotes = notes;
    current = run;
    await als.run(caseId, () => run.run());
    return { notes, browser: (identity) => contexts.get(identity) };
  };
}

describe("CaseRun after a 401 in a browser context", () => {
  it("refreshes once for 401s that arrive together, then notes only the first 401 after the refresh", async () => {
    const runCase = await startRun([
      testCase("SHOP-REAUTH-001", [
        { look: true, as: "customer" },
        { expire: true },
        { call: 2, as: "customer" },
        { look: true, as: "customer" },
        { call: 1, as: "customer" },
        { call: 1, as: "customer" },
      ]),
    ]);

    const { notes } = await runCase("SHOP-REAUTH-001");

    expect(probed).toEqual(["fake-token-1", "fake-token-1"]);
    expect(events).toEqual([
      "look with Bearer fake-token-1",
      "refresh starts in SHOP-REAUTH-001",
      "refresh ends",
      "look with Bearer fake-token-2",
    ]);
    expect(notes).toEqual([
      `refreshed customer's web credential after a 401 from ${ORIGIN}`,
      `another 401 from ${ORIGIN} after this case's one recovery`,
    ]);
    expect(lines).toEqual([]);
  });

  it("starts the next step only after a slow refresh ends, and that step sees the new credential", async () => {
    refreshDelayMs = 100;
    const runCase = await startRun([
      testCase("SHOP-REAUTH-001", [
        { look: true, as: "customer" },
        { expire: true },
        { call: 1, as: "customer" },
        { look: true, as: "customer" },
      ]),
    ]);

    await runCase("SHOP-REAUTH-001");

    expect(events).toEqual([
      "look with Bearer fake-token-1",
      "refresh starts in SHOP-REAUTH-001",
      "refresh ends",
      "look with Bearer fake-token-2",
    ]);
  });

  it("returns only after a refresh the last step started, and stops listening then", async () => {
    refreshDelayMs = 100;
    const runCase = await startRun([
      testCase("SHOP-REAUTH-001", [
        { look: true, as: "customer" },
        { expire: true },
        { call: 1, as: "customer" },
      ]),
    ]);

    const { notes, browser } = await runCase("SHOP-REAUTH-001");
    browser("customer")?.unauthorized();
    await sleep(refreshDelayMs);

    expect(events).toEqual([
      "look with Bearer fake-token-1",
      "refresh starts in SHOP-REAUTH-001",
      "refresh ends",
    ]);
    expect(notes).toEqual([`refreshed customer's web credential after a 401 from ${ORIGIN}`]);
  });

  it("adds only a case.log line when the credential still passes its probe, as after a wrong PIN, and probes again on the next 401", async () => {
    const runCase = await startRun([
      testCase("SHOP-PIN-001", [
        { look: true, as: "customer" },
        { call: 1, as: "customer" },
        { call: 1, as: "customer" },
        { look: true, as: "customer" },
      ]),
    ]);

    const { notes } = await runCase("SHOP-PIN-001");

    expect(probed).toEqual(["fake-token-1", "fake-token-1", "fake-token-1"]);
    expect(events).toEqual(["look with Bearer fake-token-1", "look with Bearer fake-token-1"]);
    expect(notes).toEqual([]);
    const line = `SHOP-PIN-001: 401 from ${ORIGIN}; the web credential of customer still passes its probe`;
    expect(lines).toEqual([line, line]);
  });

  it("notes a credential that cannot be cached and lets the case go on", async () => {
    const runCase = await startRun([
      testCase("SHOP-REAUTH-001", [
        { look: true, as: "guest" },
        { expire: true },
        { call: 1, as: "guest" },
        { look: true, as: "guest" },
        { call: 1, as: "guest" },
      ]),
    ]);

    const { notes } = await runCase("SHOP-REAUTH-001");

    expect(events.filter((event) => event.startsWith("look"))).toEqual([
      "look with Bearer fake-token-1",
      "look with Bearer fake-token-1",
    ]);
    expect(notes).toEqual([
      `got a 401 from ${ORIGIN}; the web credential of guest cannot be refreshed`,
      `another 401 from ${ORIGIN} after this case's one recovery`,
    ]);
  });

  it("refreshes when the probe throws", async () => {
    probeFailure = new Error("the probe request timed out");
    const runCase = await startRun([
      testCase("SHOP-REAUTH-001", [
        { look: true, as: "customer" },
        { expire: true },
        { call: 1, as: "customer" },
        { look: true, as: "customer" },
      ]),
    ]);

    const { notes } = await runCase("SHOP-REAUTH-001");

    expect(events).toEqual([
      "look with Bearer fake-token-1",
      "refresh starts in SHOP-REAUTH-001",
      "refresh ends",
      "look with Bearer fake-token-2",
    ]);
    expect(notes).toEqual([`refreshed customer's web credential after a 401 from ${ORIGIN}`]);
  });

  it("refreshes without a probe when the strategy has none", async () => {
    const runCase = await startRun([
      testCase("SHOP-COURIER-001", [
        { look: true, as: "courier" },
        { call: 1, as: "courier" },
        { look: true, as: "courier" },
      ]),
    ]);

    const { notes } = await runCase("SHOP-COURIER-001");

    expect(events).toEqual([
      "look with Bearer fake-token-1",
      "refresh starts in SHOP-COURIER-001",
      "refresh ends",
      "look with Bearer fake-token-2",
    ]);
    expect(notes).toEqual([`refreshed courier's web credential after a 401 from ${ORIGIN}`]);
  });

  it("runs the probe and the refresh in the case that subscribed, though the browser calls back in the case that launched it", async () => {
    const runCase = await startRun([
      testCase("SHOP-FIRST-001", [{ look: true, as: "customer" }]),
      testCase("SHOP-SECOND-001", [
        { call: 1, as: "customer" },
        { expire: true },
        { call: 1, as: "customer" },
        { look: true, as: "customer" },
      ]),
    ]);

    await runCase("SHOP-FIRST-001");
    const { notes } = await runCase("SHOP-SECOND-001");

    expect(callbacks).toEqual(["SHOP-FIRST-001", "SHOP-FIRST-001"]);
    expect(lines).toEqual([
      `SHOP-SECOND-001: 401 from ${ORIGIN}; the web credential of customer still passes its probe`,
    ]);
    expect(events).toEqual([
      "look with Bearer fake-token-1",
      "refresh starts in SHOP-SECOND-001",
      "refresh ends",
      "look with Bearer fake-token-2",
    ]);
    expect(notes).toEqual([`refreshed customer's web credential after a 401 from ${ORIGIN}`]);
  });
});

describe("CaseRun log in again after a 401", () => {
  it("logs in again when the credential cannot refresh, and the next step passes with a note", async () => {
    refreshable = false;
    const runCase = await startRun([
      testCase("SHOP-LOGIN-001", [
        { look: true, as: "customer" },
        { expire: true },
        { call: 1, as: "customer" },
        { look: true, as: "customer" },
      ]),
    ]);

    const { notes } = await runCase("SHOP-LOGIN-001");

    expect(events).toEqual(["look with Bearer fake-token-1", "look with Bearer fake-token-2"]);
    expect(notes).toEqual([`logged in again as customer on web after a 401 from ${ORIGIN}`]);
  });

  it("logs in again when the refresh throws", async () => {
    refreshFailure = new Error("the token endpoint answered 500");
    const runCase = await startRun([
      testCase("SHOP-LOGIN-001", [
        { look: true, as: "customer" },
        { expire: true },
        { call: 1, as: "customer" },
        { look: true, as: "customer" },
      ]),
    ]);

    const { notes } = await runCase("SHOP-LOGIN-001");

    expect(events.filter((event) => event.startsWith("look"))).toEqual([
      "look with Bearer fake-token-1",
      "look with Bearer fake-token-2",
    ]);
    expect(notes).toEqual([`logged in again as customer on web after a 401 from ${ORIGIN}`]);
  });

  it("blocks the case before the next step when the login fails, and still runs the finally steps", async () => {
    refreshable = false;
    const runCase = await startRun([
      {
        ...testCase("SHOP-LOGIN-001", [
          { look: true, as: "customer" },
          { expire: true },
          { "break-login": true },
          { call: 1, as: "customer" },
          { look: true, as: "customer" },
        ]),
        finally: [{ look: true, as: "customer" }],
      },
    ]);

    await expect(runCase("SHOP-LOGIN-001")).rejects.toThrow(
      `logging in again as customer on web after a 401 from ${ORIGIN} failed: the login page answered 503`,
    );

    // the look after the 401 never runs, the finally one does
    expect(events.filter((event) => event.startsWith("look"))).toEqual([
      "look with Bearer fake-token-1",
      "look with Bearer fake-token-1",
    ]);
  });

  it("keeps the failed step's outcome and notes the reason when the step that got the 401 throws", async () => {
    refreshable = false;
    const runCase = await startRun([
      testCase("SHOP-LOGIN-001", [
        { look: true, as: "customer" },
        { expire: true },
        { "break-login": true },
        { "call-and-crash": true, as: "customer" },
      ]),
    ]);

    await expect(runCase("SHOP-LOGIN-001")).rejects.toThrow("the page shows the login screen");

    expect(lastNotes).toEqual([
      `logging in again as customer on web after a 401 from ${ORIGIN} failed: the login page answered 503`,
    ]);
  });

  it("notes a second 401 once after a login, and does not log in again", async () => {
    refreshable = false;
    const runCase = await startRun([
      testCase("SHOP-LOGIN-001", [
        { look: true, as: "customer" },
        { expire: true },
        { call: 1, as: "customer" },
        { look: true, as: "customer" },
        { expire: true },
        { call: 1, as: "customer" },
        { look: true, as: "customer" },
      ]),
    ]);

    const { notes } = await runCase("SHOP-LOGIN-001");

    expect(issued).toBe(2);
    expect(notes).toEqual([
      `logged in again as customer on web after a 401 from ${ORIGIN}`,
      `another 401 from ${ORIGIN} after this case's one recovery`,
    ]);
  });

  it("blocks the case when the login a last step started fails", async () => {
    refreshable = false;
    const runCase = await startRun([
      testCase("SHOP-LOGIN-001", [
        { look: true, as: "customer" },
        { expire: true },
        { "break-login": true },
        { call: 1, as: "customer" },
      ]),
    ]);

    await expect(runCase("SHOP-LOGIN-001")).rejects.toThrow("the login page answered 503");
  });
});

describe("CaseRun closing", () => {
  it("ignores a credential load that arrives while it waits for the last recovery", async () => {
    refreshDelayMs = 100;
    applyDelayMs = 30;
    const runCase = await startRun([
      {
        ...testCase("SHOP-CLOSE-001", [{ look: true, as: "customer" }, { expire: true }]),
        finally: [{ call: 1, as: "customer" }, { "reload-later": 50 }],
      },
    ]);

    await runCase("SHOP-CLOSE-001");
    const atReturn = applied;
    await sleep(100);

    // the look and the recovery after the 401, but not the load that came in during the wait
    expect(atReturn).toBe(2);
    expect(applied).toBe(2);
  });
});
