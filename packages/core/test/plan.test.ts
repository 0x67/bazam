import { rm } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vite-plus/test";
import type { LoginMode } from "../src/auth/index.ts";
import { BRAND } from "../src/brand.ts";
import { FlowCycle } from "../src/case/index.ts";
import { HumanOnlyViolation, type ChallengeResolver } from "../src/challenge/index.ts";
import type { Capability } from "../src/driver/index.ts";
import { RunValues } from "../src/env/index.ts";
import { definePlugin, PLUGIN_API_VERSION } from "../src/plugin/index.ts";
import { defaultRedactionRules, Redactor } from "../src/redact/index.ts";
import { loginKey, planCases, planLogins, planRun, type PlanInputs, type RunPlan } from "../src/run/index.ts";
import { fakeDriver, fakeStep } from "./support/fake-driver.ts";
import { loadTestProject } from "./support/project.ts";

function resolver(name: string, kinds: readonly string[], requires: readonly Capability[] = []): ChallengeResolver {
  return { name, kinds, requires, automated: true, resolve: async () => undefined };
}

const webSteps = ["open", "tap", "fill", "expect"].map(fakeStep);
// a driver with no open and no fill step
const phone = fakeDriver({ name: "fake-phone", surface: "mobile", steps: ["swipe", "tap"].map(fakeStep) });
const plugin = (driver = fakeDriver({ steps: webSteps })) =>
  definePlugin({
    name: "test-web",
    apiVersion: PLUGIN_API_VERSION,
    drivers: [driver, phone],
    resolvers: [
      resolver("fake-otp", ["otp-email"]),
      resolver("fake-passkey", ["passkey"], ["webauthn.virtual"]),
      resolver("fake-totp-device", ["totp"], ["totp.device"]),
      resolver("fake-any", ["*"]),
    ],
  });

const config = {
  envs: {
    demo: {
      production: false,
      vars: { APP_URL: "https://app.example.test" },
      hosts: ["app.example.test"],
      challenges: { "otp-email": ["fake-otp", "human"], passkey: ["fake-passkey", "human"], totp: ["fake-totp-device"], pin: ["human"] },
    },
    live: { production: true, hosts: ["app.example.test"], challenges: { pin: ["fake-any"] } },
  },
  identities: {
    customer: {
      fixture: "customer",
      auth: {
        web: {
          strategy: "session-cookie",
          with: { login: { url: "https://app.example.test/login", until: { cookie: "session" }, person: { steps: ["Sign in"] } } },
        },
        api: { strategy: "session-cookie", from: "web" },
      },
    },
    partner: { auth: { api: { strategy: "api-key", with: { key: "fake-partner-key-0001", header: "x-api-key" } } } },
    visitor: {},
  },
  targets: { web: { driver: "fake", browser: "chromium" }, "web-alt": { driver: "fake" }, phone: { driver: "fake-phone" } },
};

type CaseFields = Record<string, unknown>;

function testCase(id: string, fields: CaseFields): CaseFields {
  return { id, title: `case ${id}`, stage: "acceptance", risk: "low", links: ["jira:TD-1"], targets: ["web"], ...fields };
}

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

interface PlanOptions {
  env?: string;
  capabilities?: readonly Capability[];
  /** Modes by login key; every other login is cached. */
  modes?: Record<string, LoginMode>;
  targets?: readonly string[];
  blockedIdentities?: ReadonlyMap<string, string>;
  flows?: unknown;
}

async function planFor(cases: readonly CaseFields[], options: PlanOptions = {}): Promise<RunPlan> {
  const files: Record<string, unknown> = { [BRAND.configFile]: config, "cases/auth/plan.yaml": { cases } };
  if (options.flows !== undefined) files["flows/flows.yaml"] = options.flows;
  const { root, project, registry } = await loadTestProject(files, [plugin()]);
  roots.push(root);
  const env = project.config.envs[options.env ?? "demo"]!;
  const capabilities = new Set(options.capabilities ?? []);
  const inputs: Omit<PlanInputs, "credentials"> = {
    project,
    env,
    cases: project.cases,
    capabilities: new Map([
      ["web", capabilities],
      ["web-alt", capabilities],
      ["phone", capabilities],
    ]),
    registry,
  };
  if (options.targets !== undefined) inputs.targets = options.targets;
  if (options.blockedIdentities !== undefined) inputs.blockedIdentities = options.blockedIdentities;
  const credentials = new Map(planLogins(inputs).map((login) => [loginKey(login), options.modes?.[loginKey(login)] ?? ("cached" as LoginMode)]));
  return planRun({ ...inputs, credentials });
}

const otp = { challenge: { kind: "otp-email", trigger: { tap: { id: "send-code" } }, fill: { id: "code" } }, as: "customer" };

describe("planRun", () => {
  it("blocks a retired case because its stage does not run", async () => {
    const plan = await planFor([testCase("AUTH-OLD-001", { stage: "retired", steps: [{ open: "${env.APP_URL}" }] })]);
    expect(plan.cases[0]?.blocked).toBe("stage retired does not run");
  });

  it("blocks a case that is not prod_safe in a production env", async () => {
    const plan = await planFor([testCase("AUTH-PROD-001", { steps: [{ open: "${env.APP_URL}" }] })], { env: "live" });
    expect(plan.cases[0]?.blocked).toBe("case AUTH-PROD-001 is not prod_safe and env live is production");
  });

  it("runs a case on the first of its targets the selection keeps, and blocks one with none selected", async () => {
    const plan = await planFor(
      [
        testCase("AUTH-BOTH-001", { targets: ["web", "web-alt"], steps: [{ open: "${env.APP_URL}" }] }),
        testCase("AUTH-WEB-001", { targets: ["web"], steps: [{ open: "${env.APP_URL}" }] }),
      ],
      { targets: ["web-alt"] },
    );
    expect(plan.cases.map(({ target, blocked }) => ({ target, blocked }))).toEqual([
      { target: "web-alt", blocked: undefined },
      { target: "web", blocked: "none of the case's targets (web) is selected (web-alt)" },
    ]);
  });

  it("blocks a challenge step that names no identity", async () => {
    const { as: _, ...anonymous } = otp;
    const plan = await planFor([testCase("AUTH-OTP-001", { steps: [anonymous] })]);
    expect(plan.cases[0]?.blocked).toBe("challenge step names no identity");
  });

  it("blocks a challenge whose chain has no resolver that can run on the target", async () => {
    const plan = await planFor([
      testCase("AUTH-TOTP-001", { steps: [{ challenge: { kind: "totp", fill: { id: "code" } }, as: "customer" }] }),
      testCase("AUTH-SMS-001", { steps: [{ challenge: { kind: "otp-sms", fill: { id: "code" } }, as: "customer" }] }),
    ]);
    expect(plan.cases.map(({ challenges, blocked }) => ({ challenges, blocked }))).toEqual([
      {
        challenges: [{ step: 1, kind: "totp", resolver: null }],
        blocked: "no resolver for challenge totp can run on target web: fake-totp-device needs totp.device",
      },
      { challenges: [{ step: 1, kind: "otp-sms", resolver: null }], blocked: "env demo has no resolver chain for challenge otp-sms" },
    ]);
  });

  it("blocks a value challenge with no fill field", async () => {
    const plan = await planFor([testCase("AUTH-OTP-001", { steps: [{ open: "${env.APP_URL}" }, { challenge: { kind: "otp-email" }, as: "customer" }] })]);
    expect(plan.cases[0]?.blocked).toBe("challenge step 2 (otp-email) names no fill field for its code");
  });

  it("blocks a value challenge on a target whose driver has no fill step", async () => {
    const plan = await planFor([testCase("AUTH-OTP-001", { targets: ["phone"], steps: [otp] })]);
    expect(plan.cases[0]?.blocked).toBe("driver fake-phone has no fill step for the code of challenge step 1");
  });

  it("blocks a step that only another target's driver offers", async () => {
    const plan = await planFor([testCase("AUTH-PHONE-001", { targets: ["phone"], steps: [{ swipe: {} }, { open: "${env.APP_URL}", as: "customer" }] })]);
    expect(plan.cases[0]?.blocked).toBe("driver fake-phone has no open step");
  });

  it("blocks a step as an identity that config does not define", async () => {
    const plan = await planFor([testCase("AUTH-WHO-001", { steps: [{ open: "${env.APP_URL}", as: "stranger" }] })]);
    expect(plan.cases[0]?.blocked).toBe(`identity stranger is not defined under identities in ${BRAND.configFile}`);
  });

  it("blocks a request as an identity with no api auth, but lets it act in a fresh browser context", async () => {
    const plan = await planFor([
      testCase("AUTH-API-001", { steps: [{ request: { method: "GET", url: "${env.APP_URL}/me", as: "visitor" } }] }),
      testCase("AUTH-WEB-001", { steps: [{ open: "${env.APP_URL}", as: "visitor" }] }),
    ]);
    expect(plan.cases.map(({ blocked, logins }) => ({ blocked, logins }))).toEqual([
      { blocked: "identity visitor has no auth for surface api", logins: [] },
      { blocked: undefined, logins: [] },
    ]);
  });

  it("blocks an identity the caller marks blocked, also when only a placeholder names it", async () => {
    const reason = "identity customer needs fixture customer, but fixtures/identities.local.yaml is missing";
    const plan = await planFor([testCase("AUTH-MAIL-001", { steps: [{ note: "mail goes to ${identity.customer.email}" }] })], {
      blockedIdentities: new Map([["customer", reason]]),
    });
    expect(plan.cases[0]).toMatchObject({ identities: ["customer"], blocked: reason });
  });

  it("picks the first resolver whose capabilities are present", async () => {
    const passkey = testCase("AUTH-PASSKEY-001", { steps: [{ challenge: { kind: "passkey", trigger: { tap: { id: "sign-in" } } }, as: "customer" }] });
    const withAuthenticator = await planFor([passkey], { capabilities: ["webauthn.virtual"] });
    const without = await planFor([passkey]);
    expect(withAuthenticator.cases[0]?.challenges).toEqual([{ step: 1, kind: "passkey", resolver: "fake-passkey" }]);
    expect(without.cases[0]?.challenges).toEqual([{ step: 1, kind: "passkey", resolver: "human" }]);
  });

  it("lists each login once with its mode, on the surface that holds the settings", async () => {
    const plan = await planFor(
      [
        testCase("AUTH-MIX-001", {
          steps: [
            { open: "${env.APP_URL}", as: "customer" },
            { request: { method: "GET", url: "${env.APP_URL}/me", as: "customer" } },
            { request: { method: "GET", url: "${env.APP_URL}/partner", as: "partner" } },
          ],
        }),
      ],
      { modes: { "customer/web": "person", "partner/api": "static" } },
    );
    expect(plan.cases[0]?.logins).toEqual([
      { identity: "customer", surface: "web", mode: "person" },
      { identity: "partner", surface: "api", mode: "static" },
    ]);
  });

  it("counts guided steps, challenges a person answers and person logins as person steps", async () => {
    const guided = { guided: { title: "Check the statement", steps: ["Open the statement"], expected: "Statement shown" } };
    const plan = await planFor(
      [
        testCase("AUTH-HUMAN-001", { steps: [{ open: "${env.APP_URL}", as: "customer" }, guided, { challenge: { kind: "pin" }, as: "customer" }] }),
        testCase("AUTH-AUTO-001", { steps: [otp] }),
        testCase("AUTH-OLD-001", { stage: "retired", steps: [guided] }),
      ],
      { modes: { "customer/web": "person" } },
    );
    // one guided step, one pin answered by a person, and the customer's web login counted once
    expect(plan.personSteps).toBe(3);
  });

  it("throws for a target that config does not define", async () => {
    await expect(planFor([testCase("AUTH-WEB-001", { targets: ["mobile"], steps: [{ note: "hello" }] })])).rejects.toThrow(
      `target mobile is not defined under targets in ${BRAND.configFile}`,
    );
  });

  it("throws FlowCycle when flows reach each other", async () => {
    const flows = {
      flows: [
        { name: "loop-a", steps: [{ use: "loop-b" }] },
        { name: "loop-b", steps: [{ use: "loop-a" }] },
      ],
    };
    await expect(planFor([testCase("AUTH-LOOP-001", { steps: [{ use: "loop-a" }] })], { flows })).rejects.toThrow(FlowCycle);
  });

  it("throws HumanOnlyViolation when the env lists an automated resolver for pin", async () => {
    const pin = testCase("AUTH-PIN-001", { prod_safe: true, steps: [{ challenge: { kind: "pin" }, as: "customer" }] });
    await expect(planFor([pin], { env: "live" })).rejects.toThrow(HumanOnlyViolation);
  });
});

describe("planCases", () => {
  it("plan uses the fake driver's probed capabilities", async () => {
    const driver = fakeDriver({ steps: webSteps, capabilities: ["webauthn.virtual"] });
    const passkey = testCase("AUTH-PASSKEY-001", { steps: [{ challenge: { kind: "passkey", trigger: { tap: { id: "sign-in" } } }, as: "visitor" }] });
    const { root, project, registry } = await loadTestProject({ [BRAND.configFile]: config, "cases/auth/plan.yaml": { cases: [passkey] } }, [plugin(driver)]);
    roots.push(root);
    const plan = await planCases({
      project,
      env: project.config.envs["demo"]!,
      cases: project.cases,
      registry,
      channel: { ask: async () => ({ kind: "timeout" }) },
      runDir: join(root, "runs", "20261107-101500-0a1b"),
      runValues: new RunValues("20261107-101500-0a1b", new Date("2026-11-07T10:15:00Z"), 7),
      seed: 7,
      redactor: new Redactor(defaultRedactionRules()),
      signal: new AbortController().signal,
    });
    expect(plan.cases[0]?.challenges).toEqual([{ step: 1, kind: "passkey", resolver: "fake-passkey" }]);
  });
});
