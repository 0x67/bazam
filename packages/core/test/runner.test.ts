import { AsyncLocalStorage } from "node:async_hooks";
import { existsSync, readFileSync } from "node:fs";
import { appendFile, mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vite-plus/test";
import { z } from "zod";
import { defineAuthStrategy, RefreshLockTimeout } from "../src/auth/index.ts";
import { BRAND } from "../src/brand.ts";
import {
  answersFileChannel,
  CASES_VAR,
  CHALLENGE_TOKEN_VAR,
  CHALLENGE_URL_VAR,
  type ChallengeRequest,
  type ChallengeResolver,
  type HumanChannel,
  type PersonAnswer,
  type PersonPrompt,
} from "../src/challenge/index.ts";
import type { DriverSession, StepContext, StepHandler } from "../src/driver/index.ts";
import { HostNotAllowed, RunValues } from "../src/env/index.ts";
import { definePlugin, PLUGIN_API_VERSION } from "../src/plugin/index.ts";
import { defaultRedactionRules, Redactor } from "../src/redact/index.ts";
import type { CaseResult, RunProgress } from "../src/result/index.ts";
import { HarnessError, runCases } from "../src/run/index.ts";
import { FakeBrowserSession } from "./support/fake-browser.ts";
import { fakeDriver, type FakeDriver, type FakeDriverOptions, type FakeSession } from "./support/fake-driver.ts";
import { loadTestProject } from "./support/project.ts";

const RUN_ID = "20261107-101500-0a1b";
const BEARER_TOKEN = "fake-bearer-token-7f3a9c";
const OTP = "482913";
const API_PASSWORD = "fake-api-password-9d4e";
const SUITE = fileURLToPath(new URL("./fixtures/runners/suite.ts", import.meta.url));
const SUITE_COMMAND = [process.execPath, SUITE, CASES_VAR, CHALLENGE_URL_VAR, CHALLENGE_TOKEN_VAR];
const SESSION_COOKIE = {
  name: "session",
  value: "fake-session-cookie-0001",
  domain: "127.0.0.1",
  path: "/",
  httpOnly: true,
};

// what the fake driver's steps and the person channels did, in order, across one run
let events: string[];
let fills: unknown[];
let otpRequests: ChallengeRequest[];
let otpAnswer: string;
let statusSeen: RunProgress[];
// the run's signal, which the fake driver's cancel step aborts
let cancel: AbortController;
// how many cases reached the meet step; the second one lets both go on
let meeting: { arrived: number; met: PromiseWithResolvers<void> };
// the tokens of fake-expiring that the app still takes
let liveTokens: Set<string>;
let issuedTokens: number;

beforeEach(() => {
  events = [];
  fills = [];
  otpRequests = [];
  otpAnswer = OTP;
  statusSeen = [];
  cancel = new AbortController();
  meeting = { arrived: 0, met: Promise.withResolvers() };
  liveTokens = new Set();
  issuedTokens = 0;
});

function json(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(body));
}

function route(req: IncomingMessage, res: ServerResponse): void {
  switch (`${req.method} ${req.url}`) {
    case "GET /me":
      return req.headers.authorization === `Bearer ${BEARER_TOKEN}`
        ? json(res, 200, { echoed: req.headers.authorization })
        : json(res, 401, {});
    case "GET /locked":
      return json(res, 401, {});
    case "GET /dropped":
      req.socket.destroy();
      return;
    case "POST /orders":
      return json(res, 201, { id: 42 });
    case "GET /orders/42":
      return json(res, 200, { status: "PAID" });
    case "POST /token":
      return json(res, 200, {});
    case "GET /skewed":
      res.setHeader("date", new Date(Date.now() - 3_600_000).toUTCString());
      return json(res, 200, {});
    default:
      return json(res, 404, {});
  }
}

let server: Server;
let origin: string;
// nothing listens here, so a connection is refused
let closedOrigin: string;

beforeAll(async () => {
  server = createServer(route);
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const closed = createServer();
  await new Promise<void>((done) => closed.listen(0, "127.0.0.1", done));
  closedOrigin = `http://127.0.0.1:${(closed.address() as AddressInfo).port}`;
  await new Promise((done) => closed.close(done));
});

afterAll(async () => {
  await new Promise((done) => server.close(done));
});

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

/** A step that notes `<case> <kind> [as <identity>]` in `events`, then acts on its resolved payload. */
function step(kind: string, act: (payload: unknown, ctx: StepContext) => Promise<void> = async () => {}): StepHandler {
  return {
    kind,
    schema: z.unknown(),
    run: async (written, ctx) => {
      events.push(`${ctx.values.get("id")} ${kind}${ctx.identity === undefined ? "" : ` as ${ctx.identity}`}`);
      await act(await ctx.resolve(written), ctx);
    },
  };
}

function webSteps(): StepHandler[] {
  return [
    step("open"),
    step("tap"),
    step("fill", async (payload) => {
      fills.push(payload);
    }),
    step("expect", async (payload, ctx) => {
      const { visible } = payload as { visible: string };
      const found = visible !== "missing";
      ctx.evidence.record({
        name: `${visible} is visible`,
        kind: "ui",
        expected: "visible",
        observed: found ? "visible" : "not found",
        ok: found,
      });
    }),
    step("screenshot", async (_payload, ctx) => {
      await ctx.evidence.attach("screen", new TextEncoder().encode("fake png bytes"), "png");
    }),
    step("crash", async () => {
      throw new Error("element gone did not appear within 5000 ms");
    }),
    step("read-status", async (_payload, ctx) => {
      statusSeen.push(readStatus((ctx.session as FakeSession).options.runDir));
    }),
    step("cancel", async () => {
      cancel.abort();
    }),
    step("meet", async () => {
      meeting.arrived += 1;
      if (meeting.arrived === 2) meeting.met.resolve();
      // a case that runs alone fails here instead of waiting for ever
      const alone = sleep(5_000, undefined, { ref: false }).then(() => {
        throw new Error("no other case reached meet");
      });
      await Promise.race([meeting.met.promise, alone]);
    }),
    step("hold", async (_payload, ctx) => {
      await sleep(20);
      events.push(`${ctx.values.get("id")} held`);
    }),
    // notes when the case starts and ends in suite.log, where the fixture suite notes its own
    step("mark", async (_payload, ctx) => {
      const log = join(projectRoot(ctx), "suite.log");
      await appendFile(log, `${ctx.values.get("id")} start\n`);
      await sleep(50);
      await appendFile(log, `${ctx.values.get("id")} end\n`);
    }),
    // the solo suite waits for this file
    step("touch", async (_payload, ctx) => {
      await writeFile(join(projectRoot(ctx), "native.marker"), "");
    }),
    step("await-result", async (_payload, ctx) => {
      const { runDir } = (ctx.session as FakeSession).options;
      const deadline = Date.now() + 5_000;
      while (readStatus(runDir).results.length === 0) {
        if (Date.now() > deadline) throw new Error("no other case finished");
        await sleep(5);
      }
    }),
  ];
}

// plugin steps that look for the identity's browser context, as pageFor does
function pluginSteps(driver: FakeDriver): StepHandler[] {
  const browser = (ctx: StepContext) => driver.sessions.at(-1)?.browsers.has(ctx.identity ?? "") ?? false;
  return [
    {
      ...step("scrape", async (_payload, ctx) => {
        events.push(`browser open: ${browser(ctx)}`);
      }),
      opensBrowser: true,
    },
    step("scrape-quietly", async (_payload, ctx) => {
      events.push(`browser open: ${browser(ctx)}`);
      if (!browser(ctx))
        throw new HarnessError(`pageFor was called as identity "${ctx.identity}"; set opensBrowser: true`);
    }),
  ];
}

function projectRoot(ctx: StepContext): string {
  return join((ctx.session as FakeSession).options.runDir, "..", "..");
}

function issueToken(): { token: string } {
  issuedTokens += 1;
  const token = `fake-expiring-token-${issuedTokens}`;
  liveTokens.add(token);
  return { token };
}

// its probe fails once the app stops taking the token, and its refresh sends a request of its own
const expiringStrategy = defineAuthStrategy<object, { token: string }>({
  name: "fake-expiring",
  config: z.object({}),
  cacheable: false,
  acquire: async () => issueToken(),
  probe: async (credential) => liveTokens.has(credential.token),
  refresh: async (_credential, _config, ctx) => {
    await ctx.http.send({ method: "POST", url: new URL(`${origin}/token`), headers: new Headers() });
    return issueToken();
  },
  apply: async (credential, target) => {
    if (target.kind === "browser")
      await target.session.setExtraHeaders({ authorization: `Bearer ${credential.token}` });
  },
  secrets: (credential) => [credential.token],
});

const bearerStrategy = defineAuthStrategy<object, { token: string }>({
  name: "fake-bearer",
  config: z.object({}),
  cacheable: false,
  acquire: async () => ({ token: BEARER_TOKEN }),
  apply: async (credential, target) => {
    const authorization = `Bearer ${credential.token}`;
    if (target.kind === "http") target.request.headers.set("authorization", authorization);
    else await target.session.setExtraHeaders({ authorization });
  },
  secrets: (credential) => [credential.token],
});

const rejectedStrategy = defineAuthStrategy<object, { token: string }>({
  name: "fake-rejected",
  config: z.object({}),
  cacheable: false,
  acquire: async () => ({ token: "fake-rejected-token-0001" }),
  probe: async () => false,
  apply: async () => {},
  secrets: (credential) => [credential.token],
});

const lockedStrategy = defineAuthStrategy<object, { token: string }>({
  name: "fake-locked",
  config: z.object({}),
  cacheable: false,
  acquire: async () => {
    throw new RefreshLockTimeout(4242);
  },
  apply: async () => {},
  secrets: () => [],
});

const otpResolver: ChallengeResolver = {
  name: "fake-otp",
  kinds: ["otp-email"],
  requires: [],
  automated: true,
  resolve: async (request) => {
    otpRequests.push(request);
    return { kind: "value", value: otpAnswer };
  },
};

const stuckResolver: ChallengeResolver = {
  name: "fake-stuck",
  kinds: ["passkey"],
  requires: [],
  automated: true,
  resolve: async () => undefined,
};

function configFor(): object {
  return {
    envs: {
      demo: {
        production: false,
        vars: { API_URL: origin },
        hosts: ["127.0.0.1"],
        challenges: { "otp-email": ["fake-otp"], passkey: ["fake-stuck"] },
      },
      live: { production: true, vars: { API_URL: origin }, hosts: ["127.0.0.1"] },
    },
    secrets: { providers: ["dotenv"], names: ["API_PASSWORD"] },
    identities: {
      customer: {
        fixture: "customer",
        auth: { web: { strategy: "fake-bearer" }, api: { strategy: "fake-bearer", from: "web" } },
      },
      shopper: {
        fixture: "shopper",
        auth: {
          web: {
            strategy: "session-cookie",
            with: {
              login: {
                url: `${origin}/login`,
                flow: "enter-email",
                until: { cookie: "session" },
                person: { steps: ["Enter the code from your email"] },
              },
            },
          },
        },
      },
      // a scripted login, with no person
      courier: {
        auth: {
          web: {
            strategy: "session-cookie",
            with: { login: { url: `${origin}/login`, flow: "enter-email", until: { cookie: "session" } } },
          },
        },
      },
      partner: {
        auth: {
          api: {
            strategy: "hmac",
            with: {
              keyId: "fake-key-id",
              secret: "${secret.API_PASSWORD}",
              maxSkewSeconds: 30,
              probe: { request: `GET ${origin}/skewed` },
            },
          },
        },
      },
      rejected: { auth: { api: { strategy: "fake-rejected" } } },
      waiting: { auth: { api: { strategy: "fake-locked" } } },
      rider: { auth: { web: { strategy: "fake-expiring" } } },
    },
    runners: {
      shop: {
        command: SUITE_COMMAND,
        results: "reports/*.xml",
        format: "junit",
        env: { SUITE_LOG: "suite.log", SUITE_HOLD_MS: "100" },
      },
      // holds no identity, so a native case can run beside it
      solo: {
        command: SUITE_COMMAND,
        results: "solo/*.xml",
        format: "junit",
        identities: [],
        env: { SUITE_RESULTS: "solo/results.xml", SUITE_WAIT_FOR: "native.marker" },
      },
    },
    targets: {
      web: { driver: "fake", headless: true },
      mobile: { driver: "fake-phone" },
      "shop-a": { runner: "shop", env: { SUITE_NAME: "shop-a" } },
      "shop-b": { runner: "shop", env: { SUITE_NAME: "shop-b" } },
      solo: { runner: "solo" },
    },
  };
}

/** The driver of target web. */
function webDriver(options: FakeDriverOptions = {}): FakeDriver {
  return fakeDriver({ capabilities: ["browser.login"], steps: webSteps(), loginCookies: [SESSION_COOKIE], ...options });
}

type CaseFields = Record<string, unknown>;

function testCase(id: string, fields: CaseFields): CaseFields {
  return {
    id,
    title: `case ${id}`,
    stage: "acceptance",
    risk: "low",
    links: ["jira:DEMO-7"],
    targets: ["web"],
    ...fields,
  };
}

interface RunSetup {
  env?: string;
  /** A function gets the run directory, as the answers-file channel needs. */
  channel?: HumanChannel | ((runDir: string) => HumanChannel);
  /** The driver of target web; webDriver() by default. */
  driver?: FakeDriver;
  /** Null leaves the local fixtures file out. */
  localFixtures?: unknown;
  /** More project files, by path from the project root. */
  files?: Record<string, unknown>;
  /** Written into the run directory before the run starts. */
  before?: (runDir: string) => Promise<void>;
  workers?: number;
}

interface Ran {
  results: CaseResult[];
  runDir: string;
  driver: FakeDriver;
  /** The driver of target mobile, which has no browser.login. */
  phone: FakeDriver;
}

/** A person who answers every prompt with done and notes `ask <prompt id>` in `events`. */
function person(
  answer: (prompt: PersonPrompt) => PersonAnswer = () => ({ kind: "done" }),
): HumanChannel & { prompts: PersonPrompt[] } {
  const prompts: PersonPrompt[] = [];
  return {
    prompts,
    ask: async (prompt) => {
      prompts.push(prompt);
      events.push(`ask ${prompt.id}`);
      return answer(prompt);
    },
  };
}

async function runProject(cases: readonly CaseFields[], setup: RunSetup = {}): Promise<Ran> {
  const driver = setup.driver ?? webDriver();
  const phone = fakeDriver({ name: "fake-phone", surface: "mobile", steps: [step("swipe")] });
  const plugin = definePlugin({
    name: "test-run",
    apiVersion: PLUGIN_API_VERSION,
    drivers: [driver, phone],
    steps: pluginSteps(driver),
    authStrategies: [bearerStrategy, rejectedStrategy, lockedStrategy, expiringStrategy],
    resolvers: [otpResolver, stuckResolver],
  });
  const files: Record<string, unknown> = {
    [BRAND.configFile]: configFor(),
    "cases/shop/run.yaml": { cases },
    "flows/login.yaml": {
      flows: [
        { name: "enter-email", steps: [{ fill: { field: { id: "email" }, value: "${identity.shopper.email}" } }] },
      ],
    },
    [join(BRAND.stateDir, "secrets.env")]: `API_PASSWORD=${API_PASSWORD}\n`,
    ...setup.files,
  };
  const localFixtures =
    setup.localFixtures === undefined
      ? { customer: { email: "customer@example.test" }, shopper: { email: "shopper@example.test" } }
      : setup.localFixtures;
  if (localFixtures !== null) files["fixtures/identities.local.yaml"] = localFixtures;
  const { root, project, registry } = await loadTestProject(files, [plugin]);
  roots.push(root);
  const runDir = join(root, "runs", RUN_ID);
  await setup.before?.(runDir);
  const results = await runCases({
    project,
    env: project.config.envs[setup.env ?? "demo"]!,
    cases: project.cases,
    registry,
    channel: typeof setup.channel === "function" ? setup.channel(runDir) : (setup.channel ?? person()),
    runDir,
    runValues: new RunValues(RUN_ID, new Date("2026-11-07T10:15:00Z"), 7),
    seed: 7,
    redactor: new Redactor(defaultRedactionRules()),
    signal: cancel.signal,
    ...(setup.workers === undefined ? {} : { workers: setup.workers }),
  });
  return { results, runDir, driver, phone };
}

function readStatus(runDir: string): RunProgress {
  return JSON.parse(readFileSync(join(runDir, "status.json"), "utf8")) as RunProgress;
}

function outcomes(results: readonly CaseResult[]): { caseId: string; status: string; reason: string | undefined }[] {
  return results.map(({ caseId, status, reason }) => ({ caseId, status, reason }));
}

const expectVisible = { expect: { visible: "dashboard" } };

describe("runCases", () => {
  it("asks person logins before the first case", async () => {
    // the login lasts until the person answers, so the run cannot drop its prompt
    const answered = Promise.withResolvers<void>();
    const channel = person(() => {
      answered.resolve();
      return { kind: "done" };
    });
    const { results, driver } = await runProject(
      [
        testCase("SHOP-FIRST-001", { steps: [{ open: "${env.API_URL}/home", as: "shopper" }, expectVisible] }),
        testCase("SHOP-SECOND-001", { steps: [{ open: "${env.API_URL}/cart", as: "shopper" }, expectVisible] }),
      ],
      { channel, driver: webDriver({ loginWaitsFor: answered.promise }) },
    );
    expect(events).toEqual([
      "ask shopper-session-cookie-login",
      "SHOP-FIRST-001 open as shopper",
      "SHOP-FIRST-001 expect",
      "SHOP-SECOND-001 open as shopper",
      "SHOP-SECOND-001 expect",
    ]);
    expect(channel.prompts[0]?.runId).toBe(RUN_ID);
    expect(driver.sessions).toHaveLength(3);
    const [preflightSession, firstCase, secondCase] = driver.sessions;
    // the login flow arrives expanded and resolved, with the prompt that tells the driver a person acts
    expect(preflightSession?.browserLogin?.requests).toEqual([
      expect.objectContaining({
        flow: [{ fill: { field: { id: "email" }, value: "shopper@example.test" } }],
        prompt: expect.objectContaining({ id: "shopper-session-cookie-login", runId: RUN_ID }),
      }),
    ]);
    // the login ran in a session of its own, which closes clean and opened no identity's browser
    expect(preflightSession?.closedWith?.status).toBe("pass");
    expect(preflightSession?.browsers.size).toBe(0);
    expect([firstCase, secondCase].map((session) => session?.browserLogin?.requests.length)).toEqual([0, 0]);
    expect(firstCase?.browsers.get("shopper")?.state.cookies).toEqual([
      expect.objectContaining({ value: SESSION_COOKIE.value }),
    ]);
    expect(results.map((result) => result.status)).toEqual(["pass", "pass"]);
  });

  it("runs scripted logins in preflight before person logins", async () => {
    const { results, driver } = await runProject([
      testCase("SHOP-FIRST-001", { steps: [{ open: "${env.API_URL}/home", as: "shopper" }, expectVisible] }),
      testCase("SHOP-COURIER-001", { steps: [{ open: "${env.API_URL}/route", as: "courier" }, expectVisible] }),
    ]);
    const logins = driver.sessions[0]?.browserLogin?.requests.map((request) => request.prompt?.id ?? "scripted");
    expect(logins).toEqual(["scripted", "shopper-session-cookie-login"]);
    expect(results.map((result) => result.status)).toEqual(["pass", "pass"]);
  });

  it("logs in on the first target whose driver offers browser.login, past a case on one that does not", async () => {
    const { results, driver, phone } = await runProject([
      testCase("SHOP-PHONE-001", {
        targets: ["mobile"],
        steps: [{ swipe: {} }],
        checks: [{ api: { request: "GET ${env.API_URL}/me", as: "customer", status: 200 } }],
      }),
      testCase("SHOP-FIRST-001", { steps: [{ open: "${env.API_URL}/home", as: "shopper" }, expectVisible] }),
    ]);
    expect(outcomes(results)).toEqual([
      { caseId: "SHOP-PHONE-001", status: "pass", reason: undefined },
      { caseId: "SHOP-FIRST-001", status: "pass", reason: undefined },
    ]);
    expect(phone.sessions).toHaveLength(1);
    expect(driver.sessions[0]?.browserLogin?.requests).toHaveLength(1);
  });

  it("dispatches steps by kind", async () => {
    const { results, driver } = await runProject([
      testCase("SHOP-ORDER-001", {
        title: "Customer places an order",
        steps: [
          { open: "${env.API_URL}/home", as: "customer" },
          {
            request: {
              method: "POST",
              url: "${env.API_URL}/orders",
              json: { amount: "${run.random(1, 9, 2)}" },
              save: { orderId: "body.id" },
            },
          },
          { note: "order ${case.orderId} for ${case.title}" },
          expectVisible,
        ],
        checks: [
          { api: { request: "GET ${env.API_URL}/orders/${case.orderId}", status: 200, body: { status: "PAID" } } },
        ],
      }),
    ]);
    expect(events).toEqual(["SHOP-ORDER-001 open as customer", "SHOP-ORDER-001 expect"]);
    expect(driver.sessions[0]?.browsers.get("customer")?.extraHeaders).toEqual({
      authorization: `Bearer ${BEARER_TOKEN}`,
    });
    const [result] = results;
    expect(result).toMatchObject({
      status: "pass",
      notes: ["order 42 for Customer places an order"],
      seed: 7,
      identities: ["customer"],
    });
    expect(result?.checks.map((check) => [check.kind, check.ok])).toEqual([
      ["ui", true],
      ["api", true],
    ]);
    expect(Object.keys(result?.values ?? {})).toEqual(["random(1, 9, 2)"]);
  });

  it("writes status.json after each case", async () => {
    const verdict = (runDir: string) =>
      person(() => {
        statusSeen.push(readStatus(runDir));
        return { kind: "verdict", verdict: "pass", note: "" };
      });
    const { runDir } = await runProject(
      [
        testCase("SHOP-ONE-001", { steps: [expectVisible] }),
        testCase("SHOP-TWO-001", {
          steps: [{ "read-status": {} }, { guided: { title: "Look at the cart", steps: ["Open the cart"] } }],
        }),
      ],
      { channel: verdict },
    );
    const afterFirst = {
      runId: RUN_ID,
      state: "running",
      total: 2,
      results: [{ caseId: "SHOP-ONE-001", status: "pass" }],
    };
    // the second read happens while the guided prompt waits for its answer
    expect(statusSeen).toEqual([
      { ...afterFirst, pendingPrompts: 0 },
      { ...afterFirst, pendingPrompts: 1 },
    ]);
    expect(readStatus(runDir)).toMatchObject({
      state: "finished",
      pendingPrompts: 0,
      results: [{ caseId: "SHOP-ONE-001" }, { caseId: "SHOP-TWO-001" }],
    });
  });

  it("runs a challenge through its chain, fills the code and records the resolver", async () => {
    const { results } = await runProject([
      testCase("SHOP-OTP-001", {
        steps: [
          {
            challenge: {
              kind: "otp-email",
              trigger: { tap: { id: "send-code" } },
              fill: { id: "code" },
              params: { recipient: "${identity.customer.email}" },
            },
            as: "customer",
          },
          expectVisible,
        ],
      }),
    ]);
    expect(otpRequests).toEqual([
      {
        kind: "otp-email",
        caseId: "SHOP-OTP-001",
        identity: "customer",
        step: 1,
        params: { recipient: "customer@example.test" },
      },
    ]);
    expect(events).toEqual(["SHOP-OTP-001 tap as customer", "SHOP-OTP-001 fill as customer", "SHOP-OTP-001 expect"]);
    expect(fills).toEqual([{ field: { id: "code" }, value: OTP }]);
    expect(results[0]).toMatchObject({
      status: "pass",
      challenges: [{ step: 1, kind: "otp-email", resolver: "fake-otp" }],
    });
  });

  it("fills a challenge answer as given, without filling in placeholders it holds", async () => {
    otpAnswer = "${secret.API_PASSWORD} $${env.API_URL}";
    const { results } = await runProject([
      testCase("SHOP-OTP-001", {
        steps: [{ challenge: { kind: "otp-email", fill: { id: "code" } }, as: "customer" }, expectVisible],
      }),
    ]);
    expect(fills).toEqual([{ field: { id: "code" }, value: otpAnswer }]);
    expect(results[0]?.status).toBe("pass");
  });

  it("evaluates a guided step's observe after the verdict and fails a pass the observation contradicts", async () => {
    const channel = person(() => ({ kind: "verdict", verdict: "pass", note: "" }));
    const { results } = await runProject(
      [
        testCase("SHOP-GUIDED-001", {
          steps: [
            { screenshot: { name: "before" } },
            {
              guided: {
                title: "Confirm the order",
                steps: ["Open the order"],
                expected: "Order is paid",
                observe: { api: { request: "GET ${env.API_URL}/locked", status: 200 } },
              },
            },
          ],
        }),
      ],
      { channel },
    );
    expect(channel.prompts[0]).toMatchObject({
      id: "SHOP-GUIDED-001-2-guided",
      ask: "verdict",
      expected: "Order is paid",
      screenshot: expect.stringMatching(/01-screen\.png$/),
    });
    expect(results[0]?.status).toBe("fail");
    expect(results[0]?.checks).toEqual([
      expect.objectContaining({
        name: "Confirm the order",
        kind: "guided",
        ok: false,
        hint: "person answered pass but the observed state disagrees",
      }),
    ]);
  });

  it("writes the summary and a post plan rendered by the tracker's renderer", async () => {
    const { runDir } = await runProject([
      testCase("SHOP-ONE-001", { steps: [expectVisible] }),
      testCase("SHOP-TWO-001", { steps: [{ crash: {} }] }),
    ]);
    const summary = JSON.parse(await readFile(join(runDir, "summary.json"), "utf8")) as {
      counts: Record<string, number>;
    };
    expect(summary.counts).toEqual({ pass: 1, fail: 1, blocked: 0, followup: 0, total: 2 });
    expect(existsSync(join(runDir, "summary.md"))).toBe(true);
    const postPlan = JSON.parse(await readFile(join(runDir, "post-plan.json"), "utf8")) as {
      items: { marker: string; ticket: unknown; comment: { markdown: string } }[];
    };
    expect(postPlan.items.map((item) => [item.marker, item.ticket])).toEqual([
      [`${BRAND.markerPrefix}:SHOP-ONE-001:${RUN_ID}`, { tracker: "jira", key: "DEMO-7" }],
      [`${BRAND.markerPrefix}:SHOP-TWO-001:${RUN_ID}`, { tracker: "jira", key: "DEMO-7" }],
    ]);
    expect(postPlan.items[1]?.comment.markdown).toContain("**Failed** on demo: SHOP-TWO-001");
  });

  it("writes account ids and receipt URLs into post-plan.json as given, though they hold long digit runs", async () => {
    const receiptUrl = "https://tracker.example.test/browse/DEMO-7?focusedCommentId=10234567";
    const receipts = {
      "jira:DEMO-7:SHOP-CRASH-001": {
        marker: `${BRAND.markerPrefix}:SHOP-CRASH-001:20261101-090000-0a1b`,
        url: receiptUrl,
        postedAt: "2026-11-01T09:00:00.000Z",
      },
    };
    const report = { comment: "update", on: { fail: { mention: ["role:qa-lead"] } } };
    const { runDir } = await runProject([testCase("SHOP-CRASH-001", { report, steps: [{ crash: {} }] })], {
      files: {
        "people.yaml": { roles: { "qa-lead": { jira: "fake-account-20165700" } } },
        [join(BRAND.stateDir, "receipts.json")]: JSON.stringify(receipts),
      },
    });
    const postPlan = JSON.parse(await readFile(join(runDir, "post-plan.json"), "utf8")) as { items: unknown[] };
    expect(postPlan.items).toEqual([
      expect.objectContaining({
        mentions: [{ role: "qa-lead", accountId: "fake-account-20165700" }],
        edit: { url: receiptUrl },
      }),
    ]);
  });

  it("writes no secret, code or token anywhere under the run directory", async () => {
    const { runDir, results } = await runProject(
      [
        testCase("SHOP-SECRET-001", {
          steps: [
            { open: "${env.API_URL}/home", as: "customer" },
            {
              challenge: { kind: "otp-email", trigger: { tap: { id: "send-code" } }, fill: { id: "code" } },
              as: "customer",
            },
            { request: { method: "GET", url: "${env.API_URL}/me", as: "customer", save: { echoed: "body.echoed" } } },
            {
              request: {
                method: "POST",
                url: "${env.API_URL}/orders",
                headers: { "x-password": "${secret.API_PASSWORD}" },
                json: { code: OTP },
              },
            },
            { note: "server saw ${case.echoed}, password ${secret.API_PASSWORD}" },
            {
              guided: {
                title: "Confirm the order",
                steps: ["Sign in with ${secret.API_PASSWORD}"],
                expected: "Order shown",
              },
            },
          ],
          checks: [
            {
              api: {
                request: "GET ${env.API_URL}/me",
                as: "customer",
                status: 200,
                body: { echoed: "${case.echoed}" },
              },
            },
          ],
        }),
      ],
      {
        before: async (dir) => {
          await mkdir(join(dir, "answers"), { recursive: true });
          await writeFile(
            join(dir, "answers", "SHOP-SECRET-001-6-guided.json"),
            JSON.stringify({ kind: "verdict", verdict: "pass" }),
          );
        },
        channel: (dir) => answersFileChannel(dir, { pollMs: 10 }),
      },
    );
    expect(results[0]?.status).toBe("pass");
    const entries = await readdir(runDir, { recursive: true, withFileTypes: true });
    const files = entries.filter((entry) => entry.isFile()).map((entry) => join(entry.parentPath, entry.name));
    expect(files.map((file) => file.slice(runDir.length + 1)).sort()).toEqual([
      "SHOP-SECRET-001/case.log",
      "SHOP-SECRET-001/result.json",
      "post-plan.json",
      "prompts/done/SHOP-SECRET-001-6-guided.json",
      "status.json",
      "summary.json",
      "summary.md",
    ]);
    for (const file of files) {
      const text = await readFile(file, "utf8");
      for (const secret of [API_PASSWORD, OTP, BEARER_TOKEN])
        expect(text, `${file} holds ${secret}`).not.toContain(secret);
    }
  });
});

describe("runCases error outcomes", () => {
  it("blocks a case whose step reaches a host outside the env, naming the host", async () => {
    const { results } = await runProject([
      testCase("SHOP-HOST-001", {
        steps: [{ request: { method: "GET", url: "http://outside.example.test/" } }, expectVisible],
      }),
    ]);
    expect(outcomes(results)).toEqual([
      {
        caseId: "SHOP-HOST-001",
        status: "blocked",
        reason: "host outside.example.test is not in the hosts of env demo",
      },
    ]);
  });

  it("blocks a case without prod_safe, and a write without write: true, in a production env", async () => {
    const { results, driver } = await runProject(
      [
        testCase("SHOP-UNSAFE-001", { steps: [expectVisible] }),
        testCase("SHOP-WRITE-001", {
          prod_safe: true,
          steps: [{ request: { method: "POST", url: "${env.API_URL}/orders" } }, expectVisible],
        }),
      ],
      { env: "live" },
    );
    expect(outcomes(results)).toEqual([
      {
        caseId: "SHOP-UNSAFE-001",
        status: "blocked",
        reason: "case SHOP-UNSAFE-001 is not prod_safe and env live is production",
      },
      { caseId: "SHOP-WRITE-001", status: "blocked", reason: "POST needs write: true in production env live" },
    ]);
    // the refused case never got a session
    expect(driver.sessions).toHaveLength(1);
  });

  it("blocks a case on a placeholder that does not resolve, and on a secret no provider has", async () => {
    const { results } = await runProject([
      testCase("SHOP-VAR-001", { steps: [{ note: "${env.MISSING_URL}" }, expectVisible] }),
      testCase("SHOP-SECRET-001", { steps: [{ note: "${secret.NOT_SET}" }, expectVisible] }),
    ]);
    expect(outcomes(results)).toEqual([
      { caseId: "SHOP-VAR-001", status: "blocked", reason: "unresolved placeholder ${env.MISSING_URL}" },
      {
        caseId: "SHOP-SECRET-001",
        status: "blocked",
        reason:
          "secret NOT_SET: no value from providers [dotenv]; set it in one of them or add the provider that holds it to secrets.providers",
      },
    ]);
  });

  it("blocks the cases of an identity whose fixture the local fixtures file lacks", async () => {
    const { results } = await runProject(
      [testCase("SHOP-FIXTURE-001", { steps: [{ open: "${env.API_URL}", as: "customer" }, expectVisible] })],
      {
        localFixtures: null,
      },
    );
    expect(results[0]?.reason).toBe(
      "identity customer needs fixture customer, but fixtures/identities.local.yaml is missing",
    );
  });

  it.each([
    [
      "blocked",
      { kind: "verdict", verdict: "blocked", note: "no phone at hand" },
      "the person answered blocked: no phone at hand",
    ],
    ["timed out", { kind: "timeout" }, "no answer from a person in time"],
  ] as const)(
    "blocks every case of an identity whose person login was answered %s",
    async (_label, answer, refusal) => {
      const { results, driver } = await runProject(
        [
          testCase("SHOP-LOGIN-001", { steps: [{ open: "${env.API_URL}", as: "shopper" }, expectVisible] }),
          testCase("SHOP-ANON-001", { steps: [expectVisible] }),
        ],
        { channel: person(() => answer), driver: webDriver({ loginDelayMs: 10_000 }) },
      );
      expect(outcomes(results)).toEqual([
        {
          caseId: "SHOP-LOGIN-001",
          status: "blocked",
          reason: `login of shopper on web failed: login prompt shopper-session-cookie-login: ${refusal}`,
        },
        { caseId: "SHOP-ANON-001", status: "pass", reason: undefined },
      ]);
      expect(driver.sessions[0]?.closedWith?.status).toBe("blocked");
    },
  );

  it("blocks an identity in preflight on a rejected credential, a held refresh lock and clock skew", async () => {
    const request = (as: string) => ({ request: { method: "GET", url: "${env.API_URL}/me", as } });
    const { results } = await runProject([
      testCase("SHOP-REJECT-001", { steps: [request("rejected")] }),
      testCase("SHOP-LOCK-001", { steps: [request("waiting")] }),
      testCase("SHOP-SKEW-001", { steps: [request("partner")] }),
    ]);
    expect(results.map((result) => result.reason)).toEqual([
      "login of rejected on api failed: the new fake-rejected credential for rejected/api failed its probe; check the probe request and the credential settings in the with: block of that surface",
      "login of waiting on api failed: timed out waiting for the refresh lock held by pid 4242; wait for that process to finish or stop it",
      expect.stringMatching(
        /^login of partner on api failed: the local clock is 360\d s away from the Date of http:\/\/127\.0\.0\.1:\d+, more than maxSkewSeconds 30$/,
      ),
    ]);
    expect(results.map((result) => result.status)).toEqual(["blocked", "blocked", "blocked"]);
  });

  it("blocks a case whose request still gets a 401", async () => {
    const { results } = await runProject([
      testCase("SHOP-UNAUTH-001", {
        steps: [{ request: { method: "GET", url: "${env.API_URL}/locked", as: "customer" } }],
      }),
    ]);
    expect(results[0]).toMatchObject({
      status: "blocked",
      reason: expect.stringMatching(/answered 401 to the api credential of customer$/),
    });
  });

  it("blocks a case whose request gets no answer because the host refuses the connection", async () => {
    const { results } = await runProject([
      testCase("SHOP-DOWN-001", {
        steps: [{ request: { method: "GET", url: `${closedOrigin}/health` } }, expectVisible],
      }),
    ]);
    expect(results[0]).toMatchObject({
      status: "blocked",
      reason: `GET ${closedOrigin}/health got no answer: connect ECONNREFUSED ${closedOrigin.slice("http://".length)}`,
    });
  });

  it("blocks only the cases that name a host whose env probe failed, and logs their identities in nowhere", async () => {
    const away = closedOrigin.replace("127.0.0.1", "localhost");
    const config = configFor() as {
      envs: { demo: { hosts: string[]; probes: object[] } };
      identities: { courier: { auth: { web: { with: { login: { url: string } } } } } };
    };
    config.envs.demo.hosts.push("localhost");
    config.envs.demo.probes = [
      { request: `GET ${away}/health`, hint: "connect the VPN" },
      { request: `GET ${origin}/orders/42`, hint: "start the demo app" },
    ];
    config.identities.courier.auth.web.with.login.url = `${away}/login`;
    const { results, driver } = await runProject(
      [
        testCase("SHOP-STEP-001", { steps: [{ request: { method: "GET", url: `${away}/orders` } }] }),
        testCase("SHOP-LOGIN-001", { steps: [{ open: "${env.API_URL}/route", as: "courier" }, expectVisible] }),
        testCase("SHOP-FIRST-001", { steps: [{ open: "${env.API_URL}/home", as: "shopper" }, expectVisible] }),
        testCase("SHOP-DOWN-001", { steps: [{ request: { method: "GET", url: `${closedOrigin}/health` } }] }),
      ],
      { files: { [BRAND.configFile]: config } },
    );
    const refused = `failed: .*ECONNREFUSED.*; connect the VPN$`;
    expect(results.map((result) => result.status)).toEqual(["blocked", "blocked", "pass", "blocked"]);
    expect(results[0]?.reason).toMatch(new RegExp(`^GET ${away}/health ${refused}`));
    expect(results[1]?.reason).toBe(results[0]?.reason);
    // only the shopper logged in, and not the courier whose login URL sits on the unreachable host
    expect(driver.sessions[0]?.browserLogin?.requests).toHaveLength(1);
    expect(results[3]?.reason).toMatch(/got no answer: .*ECONNREFUSED.*; start the demo app$/);
  });

  it("fails a case whose server drops the connection after the request reached it", async () => {
    const { results } = await runProject([
      testCase("SHOP-DROP-001", {
        steps: [{ request: { method: "GET", url: "${env.API_URL}/dropped" } }, expectVisible],
      }),
    ]);
    expect(results[0]).toMatchObject({ status: "fail", reason: "step 1 (request): fetch failed" });
  });

  it("blocks a case whose session reports on close a navigation its guard refused, naming the host", async () => {
    const driver = webDriver({ closeError: new HostNotAllowed("late.example.test", "demo") });
    const { results } = await runProject([testCase("SHOP-LATE-001", { steps: [expectVisible] })], { driver });
    expect(outcomes(results)).toEqual([
      { caseId: "SHOP-LATE-001", status: "blocked", reason: "host late.example.test is not in the hosts of env demo" },
    ]);
  });

  it("blocks a case whose step failed after a navigation the guard refused and no step threw", async () => {
    const driver = webDriver({ closeError: new HostNotAllowed("late.example.test", "demo") });
    const { results } = await runProject([testCase("SHOP-LATE-002", { steps: [{ crash: {} }] })], { driver });
    expect(outcomes(results)).toEqual([
      { caseId: "SHOP-LATE-002", status: "blocked", reason: "host late.example.test is not in the hosts of env demo" },
    ]);
  });

  it("blocks a case whose challenge chain gives no answer, with the resolver's reason", async () => {
    const { results } = await runProject([
      testCase("SHOP-PASSKEY-001", {
        steps: [{ challenge: { kind: "passkey", trigger: { tap: { id: "sign-in" } } }, as: "customer" }, expectVisible],
      }),
    ]);
    expect(outcomes(results)).toEqual([
      { caseId: "SHOP-PASSKEY-001", status: "blocked", reason: 'resolver "fake-stuck" found no answer' },
    ]);
  });

  it.each([
    [
      "answers blocked",
      { kind: "verdict", verdict: "blocked", note: "no test card" },
      "blocked",
      "person: blocked: no test card",
    ],
    ["times out", { kind: "timeout" }, "blocked", 'no verdict from a person for "Pay by card" in time'],
    ["answers fail", { kind: "verdict", verdict: "fail", note: "" }, "fail", undefined],
  ] as const)("ends a guided case when the person %s", async (_label, answer, status, reason) => {
    const guided = {
      guided: { title: "Pay by card", steps: ["Pay with the test card"], expected: "Payment accepted" },
    };
    const { results } = await runProject([testCase("SHOP-PAY-001", { steps: [guided] })], {
      channel: person(() => answer),
    });
    expect(outcomes(results)).toEqual([{ caseId: "SHOP-PAY-001", status, reason }]);
  });

  it("keeps the person's blocked reason without running the guided step's observe", async () => {
    const observe = { api: { request: "GET ${env.API_URL}/locked", as: "customer", status: 200 } };
    const guided = { guided: { title: "Pay by card", steps: ["Pay with the test card"], observe } };
    const { results } = await runProject([testCase("SHOP-PAY-001", { steps: [guided] })], {
      channel: person(() => ({ kind: "verdict", verdict: "blocked", note: "no test card" })),
    });
    expect(outcomes(results)).toEqual([
      { caseId: "SHOP-PAY-001", status: "blocked", reason: "person: blocked: no test card" },
    ]);
  });

  it("fails a case whose driver step throws, and closes its session with fail before writing result.json", async () => {
    const { results, driver, runDir } = await runProject([
      testCase("SHOP-CRASH-001", { steps: [expectVisible, { crash: {} }] }),
    ]);
    expect(outcomes(results)).toEqual([
      {
        caseId: "SHOP-CRASH-001",
        status: "fail",
        reason: "step 2 (crash): element gone did not appear within 5000 ms",
      },
    ]);
    expect(driver.sessions[0]?.closedWith?.status).toBe("fail");
    // the trace the session attached on close is in the result
    const written = JSON.parse(await readFile(join(runDir, "SHOP-CRASH-001", "result.json"), "utf8")) as CaseResult;
    expect(written.attachments).toEqual(["01-trace.zip"]);
  });

  it("stops the run when the first case's session cannot launch", async () => {
    await expect(
      runProject([testCase("SHOP-FIRST-001", { steps: [expectVisible] })], {
        driver: webDriver({ failingLaunches: [1] }),
      }),
    ).rejects.toThrow("could not launch target web: fake launch 1 failed");
  });

  it("stops the run without launching again when the session for the logins cannot launch", async () => {
    const driver = webDriver({ failingLaunches: [1] });
    const cases = [
      testCase("SHOP-COURIER-001", { steps: [{ open: "${env.API_URL}/route", as: "courier" }, expectVisible] }),
      testCase("SHOP-FIRST-001", { steps: [{ open: "${env.API_URL}/home", as: "shopper" }, expectVisible] }),
    ];
    await expect(runProject(cases, { driver })).rejects.toThrow(
      "could not launch target web for the logins: fake launch 1 failed",
    );
    expect(driver.sessions).toEqual([]);
  });

  it("blocks a later case whose session cannot launch", async () => {
    const { results } = await runProject(
      [testCase("SHOP-ONE-001", { steps: [expectVisible] }), testCase("SHOP-TWO-001", { steps: [expectVisible] })],
      {
        driver: webDriver({ failingLaunches: [2] }),
      },
    );
    expect(outcomes(results)).toEqual([
      { caseId: "SHOP-ONE-001", status: "pass", reason: undefined },
      { caseId: "SHOP-TWO-001", status: "blocked", reason: "could not launch target web: fake launch 2 failed" },
    ]);
  });

  it("blocks the running case and every later one when the run is cancelled", async () => {
    const { results, driver } = await runProject([
      testCase("SHOP-ONE-001", { steps: [{ cancel: {} }, expectVisible] }),
      testCase("SHOP-TWO-001", { steps: [expectVisible] }),
    ]);
    expect(outcomes(results)).toEqual([
      { caseId: "SHOP-ONE-001", status: "blocked", reason: "run cancelled" },
      { caseId: "SHOP-TWO-001", status: "blocked", reason: "run cancelled" },
    ]);
    expect(driver.sessions).toHaveLength(1);
  });

  it("blocks a case with an internal: reason on an error inside the harness, with the stack in the case log", async () => {
    const broken: HumanChannel = {
      ask: async () => {
        throw new TypeError("cannot read the answer");
      },
    };
    const guided = { guided: { title: "Look at the page", steps: ["Look"] } };
    const { results, runDir } = await runProject([testCase("SHOP-BROKEN-001", { steps: [guided] })], {
      channel: broken,
    });
    expect(outcomes(results)).toEqual([
      { caseId: "SHOP-BROKEN-001", status: "blocked", reason: "internal: cannot read the answer" },
    ]);
    expect(await readFile(join(runDir, "SHOP-BROKEN-001", "case.log"), "utf8")).toMatch(
      /^TypeError: cannot read the answer\n\s+at /,
    );
  });
});

describe("runCases with workers", () => {
  it("never runs two cases that share an identity at once", async () => {
    const steps = [{ open: "${env.API_URL}/home", as: "customer" }, { hold: {} }, expectVisible];
    const { results } = await runProject([testCase("SHOP-A-001", { steps }), testCase("SHOP-B-001", { steps })], {
      workers: 2,
    });
    expect(events).toEqual([
      "SHOP-A-001 open as customer",
      "SHOP-A-001 hold",
      "SHOP-A-001 held",
      "SHOP-A-001 expect",
      "SHOP-B-001 open as customer",
      "SHOP-B-001 hold",
      "SHOP-B-001 held",
      "SHOP-B-001 expect",
    ]);
    expect(results.map((result) => result.status)).toEqual(["pass", "pass"]);
  });

  it("runs two cases that share no identity at once", async () => {
    const { results } = await runProject(
      [
        testCase("SHOP-A-001", {
          steps: [{ open: "${env.API_URL}/home", as: "customer" }, { meet: {} }, expectVisible],
        }),
        testCase("SHOP-B-001", { steps: [{ meet: {} }, expectVisible] }),
      ],
      { workers: 2 },
    );
    expect(outcomes(results)).toEqual([
      { caseId: "SHOP-A-001", status: "pass", reason: undefined },
      { caseId: "SHOP-B-001", status: "pass", reason: undefined },
    ]);
  });

  it("writes each case's log lines to its own case.log", async () => {
    const { results, runDir } = await runProject(
      [
        testCase("SHOP-A-001", {
          steps: [{ request: { method: "GET", url: "${env.API_URL}/orders/42" } }, { meet: {} }, expectVisible],
        }),
        testCase("SHOP-B-001", {
          steps: [{ request: { method: "GET", url: "${env.API_URL}/skewed" } }, { meet: {} }, expectVisible],
        }),
      ],
      { workers: 2 },
    );
    expect(results.map((result) => result.status)).toEqual(["pass", "pass"]);
    const first = await readFile(join(runDir, "SHOP-A-001", "case.log"), "utf8");
    const second = await readFile(join(runDir, "SHOP-B-001", "case.log"), "utf8");
    expect(first).toContain("/orders/42 200");
    expect(first).not.toContain("/skewed");
    expect(second).toContain("/skewed 200");
    expect(second).not.toContain("/orders/42");
  });

  it("lists results in status.json as they finish and in summary.json in plan order", async () => {
    const { results, runDir } = await runProject(
      [
        testCase("SHOP-A-001", { steps: [{ "await-result": {} }, expectVisible] }),
        testCase("SHOP-B-001", { steps: [expectVisible] }),
      ],
      { workers: 2 },
    );
    expect(results.map((result) => result.caseId)).toEqual(["SHOP-A-001", "SHOP-B-001"]);
    expect(readStatus(runDir).results.map((result) => result.caseId)).toEqual(["SHOP-B-001", "SHOP-A-001"]);
    const summary = JSON.parse(await readFile(join(runDir, "summary.json"), "utf8")) as { cases: { caseId: string }[] };
    expect(summary.cases.map((entry) => entry.caseId)).toEqual(["SHOP-A-001", "SHOP-B-001"]);
  });

  it("stops the run and cancels the cases still launching when the first session to launch fails", async () => {
    const inner = webDriver({ failingLaunches: [1] });
    const held = Promise.withResolvers<void>();
    let launches = 0;
    const driver: FakeDriver = {
      ...inner,
      launch: async (options) => {
        launches += 1;
        // the first case's launch goes on only after the second case's launch failed
        if (launches === 1) await held.promise;
        try {
          return await inner.launch(options);
        } catch (error) {
          setImmediate(held.resolve);
          throw error;
        }
      },
    };
    let runDir = "";
    const cases = ["SHOP-A-001", "SHOP-B-001", "SHOP-C-001"].map((id) => testCase(id, { steps: [expectVisible] }));
    const before = async (dir: string) => {
      runDir = dir;
    };
    await expect(runProject(cases, { driver, workers: 2, before })).rejects.toThrow(
      "could not launch target web: fake launch 1 failed",
    );
    expect(launches).toBe(2);
    expect(events).toEqual([]);
    expect(driver.sessions.map((session) => session.closedWith?.status)).toEqual(["blocked"]);
    const first = JSON.parse(await readFile(join(runDir, "SHOP-A-001", "result.json"), "utf8")) as CaseResult;
    expect(first).toMatchObject({ status: "blocked", reason: "run cancelled" });
    expect(existsSync(join(runDir, "SHOP-C-001"))).toBe(false);
  });

  it("shows the prompts of two cases that ask a person at the same time one at a time", async () => {
    let showing = 0;
    let most = 0;
    const channel: HumanChannel = {
      ask: async (prompt) => {
        showing += 1;
        most = Math.max(most, showing);
        events.push(`ask ${prompt.id}`);
        await sleep(20);
        showing -= 1;
        return { kind: "verdict", verdict: "pass", note: "" };
      },
    };
    const guided = { guided: { title: "Look at the cart", steps: ["Open the cart"] } };
    const { results } = await runProject(
      [
        testCase("SHOP-A-001", { steps: [{ meet: {} }, guided] }),
        testCase("SHOP-B-001", { steps: [{ meet: {} }, guided] }),
      ],
      { channel, workers: 2 },
    );
    expect(results.map((result) => result.status)).toEqual(["pass", "pass"]);
    expect(events.filter((event) => event.startsWith("ask")).sort()).toEqual([
      "ask SHOP-A-001-2-guided",
      "ask SHOP-B-001-2-guided",
    ]);
    expect(most).toBe(1);
  });
});

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

  /** The page got a 401 from the app. */
  unauthorized(): void {
    for (const listener of this.#listeners) this.#launched(() => listener(origin));
  }
}

/** A driver whose sessions share one browser, launched by the first case that runs, with one context per identity. */
function pooledDriver(): FakeDriver {
  let pool: { launched: Launched; contexts: Map<string, PooledContext> } | undefined;
  const sessions: FakeSession[] = [];
  const contextOf = async (ctx: StepContext): Promise<PooledContext> => {
    const browser = await ctx.session.browserFor?.(ctx.identity ?? "");
    if (!(browser instanceof PooledContext)) throw new Error("the step runs without the identity's browser context");
    return browser;
  };
  return {
    name: "fake",
    surface: "web",
    probe: async () => new Set(),
    launch: async (options): Promise<DriverSession> => {
      pool ??= { launched: AsyncLocalStorage.snapshot(), contexts: new Map() };
      const { launched, contexts } = pool;
      const session: FakeSession = {
        options,
        capabilities: new Set(),
        browsers: new Map(),
        closedWith: undefined,
        close: async (ending) => {
          session.closedWith = ending;
        },
        browserFor: async (identity) => {
          const context = contexts.get(identity) ?? new PooledContext(launched);
          contexts.set(identity, context);
          return context;
        },
      };
      sessions.push(session);
      return session;
    },
    steps: [
      step("look"),
      // the login flow of the shared config uses it
      step("fill"),
      // the app stops taking every token issued so far
      step("expire", async () => {
        liveTokens.clear();
      }),
      step("unauthorized", async (_payload, ctx) => {
        (await contextOf(ctx)).unauthorized();
      }),
    ],
    sessions,
  };
}

describe("runCases with workers and a pooled browser", () => {
  it.each([1, 2])(
    "logs the refresh after a 401 in case B only in B's case.log, though case A launched the browser (workers: %i)",
    async (workers) => {
      const look = { look: {}, as: "rider" };
      const { results, runDir, driver } = await runProject(
        [
          testCase("SHOP-A-001", { steps: [look] }),
          testCase("SHOP-B-001", { steps: [look, { expire: {} }, { unauthorized: {}, as: "rider" }, look] }),
        ],
        { driver: pooledDriver(), workers },
      );
      expect(driver.sessions).toHaveLength(2);
      expect(results.map((result) => result.notes)).toEqual([
        [],
        [`refreshed rider's web credential after a 401 from ${origin}`],
      ]);
      expect(await readFile(join(runDir, "SHOP-B-001", "case.log"), "utf8")).toContain(`POST ${origin}/token 200`);
      const first = join(runDir, "SHOP-A-001", "case.log");
      expect(existsSync(first) ? await readFile(first, "utf8") : "").not.toContain("/token");
    },
  );
});

describe("runCases with external suites", () => {
  const external = (id: string, target: string, fields: CaseFields = {}) =>
    testCase(id, { targets: [target], ...fields });
  const suiteLog = async (runDir: string) =>
    (await readFile(join(runDir, "..", "..", "suite.log"), "utf8")).trim().split("\n");

  it("never runs an external suite and a native case that share an identity at once", async () => {
    const { results, runDir } = await runProject(
      [
        external("SHOP-SUITE-001", "shop-a"),
        testCase("SHOP-NATIVE-001", {
          steps: [{ open: "${env.API_URL}/home", as: "customer" }, { mark: {} }, expectVisible],
        }),
      ],
      { workers: 2 },
    );
    expect(results.map((result) => result.status)).toEqual(["pass", "pass"]);
    expect(await suiteLog(runDir)).toEqual([
      "shop-a start",
      "shop-a end",
      "SHOP-NATIVE-001 start",
      "SHOP-NATIVE-001 end",
    ]);
  });

  it("never runs two targets of one runner at once", async () => {
    // the runner holds no identity, so only its runner lock keeps its targets apart
    const config = configFor() as { runners: Record<string, object> };
    const { results, runDir } = await runProject(
      [external("SHOP-SUITE-001", "shop-a"), external("SHOP-SUITE-002", "shop-b")],
      {
        workers: 2,
        files: {
          [BRAND.configFile]: {
            ...config,
            runners: { ...config.runners, shop: { ...config.runners["shop"], identities: [] } },
          },
        },
      },
    );
    expect(outcomes(results)).toEqual([
      { caseId: "SHOP-SUITE-001", status: "pass", reason: undefined },
      { caseId: "SHOP-SUITE-002", status: "pass", reason: undefined },
    ]);
    expect(await suiteLog(runDir)).toEqual(["shop-a start", "shop-a end", "shop-b start", "shop-b end"]);
  });

  it("does not read again a result file that a suite of another target already read", async () => {
    const config = configFor() as { targets: Record<string, unknown> };
    const { results, runDir } = await runProject(
      [external("SHOP-CART-001", "shop-a"), external("SHOP-CART-002", "shop-b")],
      {
        files: {
          [BRAND.configFile]: {
            ...config,
            targets: {
              ...config.targets,
              "shop-a": { runner: "shop", env: { SUITE_NAME: "shop-a", SUITE_WRITE: "SHOP-CART-001,SHOP-CART-002" } },
              "shop-b": { runner: "shop", env: { SUITE_NAME: "shop-b", SUITE_NO_RESULTS: "1", SUITE_EXIT: "1" } },
            },
          },
        },
      },
    );
    expect(outcomes(results)).toEqual([
      { caseId: "SHOP-CART-001", status: "pass", reason: undefined },
      {
        caseId: "SHOP-CART-002",
        status: "blocked",
        reason: "runner shop exited 1 and wrote no results matching reports/*.xml",
      },
    ]);
    expect(await readFile(join(runDir, "run.log"), "utf8")).toContain(
      "[shop-b] skipped reports/results.xml: another target of this run already read it, and it has not changed since",
    );
  });

  it.each([
    {
      roots: "equal roots",
      first: { name: "ui", results: "reports/*.xml", file: "reports/ui.xml" },
      second: { name: "api", results: "reports/*.xml", file: "reports/api.xml" },
    },
    {
      roots: "one root inside the other",
      first: { name: "api", results: "reports/api/*.xml", file: "reports/api/api.xml" },
      second: { name: "ui", results: "reports/**/*.xml", file: "reports/ui.xml" },
    },
  ])("never runs two runners whose result globs reach one folder at once ($roots)", async ({ first, second }) => {
    const config = configFor() as { runners: Record<string, unknown>; targets: Record<string, unknown> };
    const suite = (name: string, results: string, env: Record<string, string>) => ({
      command: SUITE_COMMAND,
      results,
      format: "junit",
      identities: [],
      env: { SUITE_LOG: "suite.log", SUITE_NAME: name, ...env },
    });
    const names = [first.name, second.name, "solo"];
    const caseId = (name: string) => `SHOP-${name.toUpperCase()}-001`;
    const { results, runDir } = await runProject(
      names.map((name) => external(caseId(name), name)),
      {
        workers: 2,
        files: {
          [BRAND.configFile]: {
            ...config,
            runners: {
              ...config.runners,
              // the first writes its file, then runs on until solo has written its own
              [first.name]: suite(first.name, first.results, {
                SUITE_RESULTS: first.file,
                SUITE_WAIT_AFTER: "solo/results.xml",
              }),
              [second.name]: suite(second.name, second.results, {
                SUITE_RESULTS: second.file,
                SUITE_WAIT_FOR: first.file,
              }),
              solo: suite("solo", "solo/*.xml", { SUITE_RESULTS: "solo/results.xml" }),
            },
            targets: { ...config.targets, ui: { runner: "ui" }, api: { runner: "api" } },
          },
        },
      },
    );
    expect(outcomes(results)).toEqual(
      names.map((name) => ({ caseId: caseId(name), status: "pass", reason: undefined })),
    );
    expect(JSON.parse(await readFile(join(runDir, "summary.json"), "utf8"))).not.toHaveProperty("unmapped");
    const log = await suiteLog(runDir);
    expect(log.filter((line) => !line.startsWith("solo "))).toEqual([
      `${first.name} start`,
      `${first.name} end`,
      `${second.name} start`,
      `${second.name} end`,
    ]);
    // the first ends only after solo writes its file, so solo ran beside it
    expect(log.indexOf("solo start")).toBeLessThan(log.indexOf(`${first.name} end`));
  });

  it.each([{ identities: [] }, { identities: ["shopper"] }])(
    "gives an external suite one worker, however many cases it runs (runner identities $identities)",
    async ({ identities }) => {
      // the suite finishes only once the native case, which needs the second worker, has written its marker
      // the native case acts as customer, so it gets that worker only when the runner's list leaves customer out
      const config = configFor() as { runners: Record<string, object> };
      const { results } = await runProject(
        [
          external("SHOP-SOLO-001", "solo"),
          external("SHOP-SOLO-002", "solo"),
          testCase("SHOP-MEET-001", { steps: [{ touch: {}, as: "customer" }, expectVisible] }),
        ],
        {
          workers: 2,
          files: {
            [BRAND.configFile]: {
              ...config,
              runners: { ...config.runners, solo: { ...config.runners["solo"], identities } },
            },
          },
        },
      );
      expect(results.map((result) => result.status)).toEqual(["pass", "pass", "pass"]);
    },
  );

  it("blocks only its own case when a launch fails after an external suite finished", async () => {
    const { results, runDir } = await runProject(
      [external("SHOP-SUITE-001", "shop-a"), testCase("SHOP-HOME-001", { steps: [expectVisible] })],
      { driver: webDriver({ failingLaunches: [1] }) },
    );
    expect(outcomes(results)).toEqual([
      { caseId: "SHOP-SUITE-001", status: "pass", reason: undefined },
      { caseId: "SHOP-HOME-001", status: "blocked", reason: "could not launch target web: fake launch 1 failed" },
    ]);
    expect(existsSync(join(runDir, "summary.json"))).toBe(true);
    expect(existsSync(join(runDir, "post-plan.json"))).toBe(true);
  });
});

describe("runCases production confirmation", () => {
  const external = testCase("SHOP-SUITE-001", { targets: ["shop-a"], prod_safe: true });
  const pass: PersonAnswer = { kind: "verdict", verdict: "pass", note: "" };

  it("runs a runner without prodSafe after a yes", async () => {
    const channel = person(() => pass);
    const { results } = await runProject([external], { env: "live", channel });
    expect(outcomes(results)).toEqual([{ caseId: "SHOP-SUITE-001", status: "pass", reason: undefined }]);
    expect(channel.prompts).toEqual([
      {
        id: expect.stringMatching(/^preflight-shop-confirm-[0-9a-f]{7}$/),
        runId: RUN_ID,
        caseId: "",
        ask: "verdict",
        title: "Run runner shop against production env live?",
        steps: [
          `It runs \`${SUITE_COMMAND.join(" ")}\`, its whole suite`,
          `${BRAND.name} cannot hold it to the host allowlist or the production write guard`,
        ],
        expected: "Answer y to run it, n to skip it",
        timeoutMs: 300_000,
      },
    ]);
  });

  it.each([
    ["no", { kind: "verdict", verdict: "fail", note: "not during the sale" }, ": not during the sale"],
    ["no answer in time", { kind: "timeout" }, ""],
  ] as const)("blocks the runner's cases and starts no process on %s", async (_label, answer, note) => {
    const { results, runDir } = await runProject([external], { env: "live", channel: person(() => answer) });
    expect(outcomes(results)).toEqual([
      {
        caseId: "SHOP-SUITE-001",
        status: "blocked",
        reason: `production run of runner shop was not confirmed${note}`,
      },
    ]);
    expect(existsSync(join(runDir, "..", "..", "suite.log"))).toBe(false);
    expect(existsSync(join(runDir, "runner-shop-a"))).toBe(false);
  });

  it("asks before the person logins", async () => {
    // the login lasts until the person answers, so the run cannot drop its prompt
    const answered = Promise.withResolvers<void>();
    const channel = person((prompt) => {
      if (prompt.ask === "verdict") return pass;
      answered.resolve();
      return { kind: "done" };
    });
    const { results } = await runProject(
      [
        testCase("SHOP-LOGIN-001", {
          prod_safe: true,
          steps: [{ open: "${env.API_URL}/home", as: "shopper" }, expectVisible],
        }),
        external,
      ],
      { env: "live", channel, driver: webDriver({ loginWaitsFor: answered.promise }) },
    );
    expect(results.map((result) => result.status)).toEqual(["pass", "pass"]);
    expect(events.slice(0, 2)).toEqual([
      expect.stringMatching(/^ask preflight-shop-confirm-[0-9a-f]{7}$/),
      "ask shopper-session-cookie-login",
    ]);
  });

  it("opens the browser of a plugin step that sets opensBrowser, and blocks the case of one that needs it without", async () => {
    const { results } = await runProject([
      testCase("SHOP-SCRAPE-001", { steps: [{ scrape: {}, as: "customer" }, expectVisible] }),
      testCase("SHOP-SCRAPE-002", { steps: [{ "scrape-quietly": {}, as: "customer" }] }),
    ]);
    expect(events).toEqual([
      "SHOP-SCRAPE-001 scrape as customer",
      "browser open: true",
      "SHOP-SCRAPE-001 expect",
      "SHOP-SCRAPE-002 scrape-quietly as customer",
      "browser open: false",
    ]);
    expect(outcomes(results)).toEqual([
      { caseId: "SHOP-SCRAPE-001", status: "pass", reason: undefined },
      {
        caseId: "SHOP-SCRAPE-002",
        status: "blocked",
        reason: 'internal: pageFor was called as identity "customer"; set opensBrowser: true',
      },
    ]);
  });
});
