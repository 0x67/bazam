import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { z } from "zod";
import { defineAuthStrategy, type AuthStrategy } from "../src/auth/index.ts";
import { BRAND } from "../src/brand.ts";
import {
  HumanOnlyViolation,
  builtinKinds,
  humanResolver,
  type ChallengeKindSpec,
  type ChallengeResolver,
  type HumanChannel,
  type PersonPrompt,
} from "../src/challenge/index.ts";
import type { CheckRule } from "../src/check/index.ts";
import { builtinRules } from "../src/check/index.ts";
import type { Environment } from "../src/env/index.ts";
import type { ResultFormat } from "../src/ingest/index.ts";
import { junitFormat } from "../src/ingest/junit.ts";
import { playwrightJsonFormat } from "../src/ingest/playwright.ts";
import {
  definePlugin,
  PLUGIN_API_VERSION,
  PluginApiMismatch,
  PluginConflict,
  PluginRegistry,
  type PluginManifest,
} from "../src/plugin/index.ts";
import { ProjectConfig } from "../src/project.ts";
import { markdownTracker, type TrackerClient, type TrackerRenderer } from "../src/report/index.ts";
import type { CaseResult } from "../src/result/index.ts";
import type { PlanCheck } from "../src/run/index.ts";
import type { SecretProvider } from "../src/secrets/index.ts";
import { fakeDriver, fakeStep } from "./support/fake-driver.ts";

const projectRoot = fileURLToPath(new URL("./fixtures/plugins", import.meta.url));

function config(fields: object = {}): ProjectConfig {
  return ProjectConfig.parse({ envs: {}, ...fields });
}

function plugin(
  name: string,
  contributions: Omit<PluginManifest, "name" | "apiVersion"> = {},
): PluginManifest {
  return definePlugin({ name, apiVersion: PLUGIN_API_VERSION, ...contributions });
}

async function loadFailure(
  defaults: readonly PluginManifest[],
  plugins: readonly string[] = [],
): Promise<unknown> {
  return PluginRegistry.load(config({ plugins }), projectRoot, defaults).then(
    () => undefined,
    (error: unknown) => error,
  );
}

async function stepKinds(plugins: readonly string[]): Promise<string[]> {
  const registry = await PluginRegistry.load(config({ plugins }), projectRoot, []);
  return registry.stepHandlers().map((step) => step.kind);
}

function secretProvider(name: string): SecretProvider {
  return { name, load: async () => undefined };
}

function challengeResolver(name: string, kinds: readonly string[]): ChallengeResolver {
  return { name, kinds, requires: [], automated: true, resolve: async () => undefined };
}

const faceScan: ChallengeKindSpec = {
  name: "face-scan",
  answer: "action",
  humanOnly: true,
  fallbackAfterTrigger: false,
};

function slackChannel(): { name: string; create(runDir: string): HumanChannel } {
  return { name: "slack", create: () => ({ ask: async () => ({ kind: "timeout" }) }) };
}

function trackerRenderer(tracker: string): TrackerRenderer {
  return { tracker, render: () => ({ markdown: `${tracker} comment` }) };
}

function resultFormat(name: string): ResultFormat {
  return { name, parse: async () => [] };
}

function trackerClient(tracker: string): TrackerClient {
  return {
    tracker,
    connect: async () => {
      throw new Error(`${tracker} is not reachable from this test`);
    },
  };
}

function checkRule(id: string): CheckRule {
  return { id, check: () => [] };
}

function authStrategy(name: string): AuthStrategy<object, { token: string }> {
  return defineAuthStrategy({
    name,
    config: z.object({}),
    cacheable: false,
    acquire: async () => ({ token: "fake-token" }),
    apply: async () => {},
    secrets: (credential) => [credential.token],
  });
}

describe("PluginRegistry.load", () => {
  it("PluginConflict names both plugins", async () => {
    const failure = await loadFailure([
      plugin("mail", { steps: [fakeStep("wait")] }),
      plugin("sms", { steps: [fakeStep("wait")] }),
    ]);

    expect(failure).toBeInstanceOf(PluginConflict);
    expect((failure as PluginConflict).plugins).toEqual(["mail", "sms"]);
    expect((failure as PluginConflict).message).toBe(
      'step kind "wait" comes from both plugin "mail" and plugin "sms"',
    );
  });

  it.each([
    [
      "two drivers with one name",
      { drivers: [fakeDriver({ name: "playwright" })] },
      { drivers: [fakeDriver({ name: "playwright" })] },
      'driver "playwright"',
    ],
    [
      "a driver step with the kind of a plugin step",
      { steps: [fakeStep("tap")] },
      { drivers: [fakeDriver({ steps: [fakeStep("tap")] })] },
      'step kind "tap"',
    ],
    [
      "two auth strategies with one name",
      { authStrategies: [authStrategy("sso")] },
      { authStrategies: [authStrategy("sso")] },
      'auth strategy "sso"',
    ],
    [
      "two resolvers with one name",
      { resolvers: [challengeResolver("totp", ["totp"])] },
      { resolvers: [challengeResolver("totp", ["totp"])] },
      'challenge resolver "totp"',
    ],
    [
      "two challenge kinds with one name",
      { challengeKinds: [faceScan] },
      { challengeKinds: [faceScan] },
      'challenge kind "face-scan"',
    ],
    [
      "two channels with one name",
      { channels: [slackChannel()] },
      { channels: [slackChannel()] },
      'human channel "slack"',
    ],
    [
      "two check rules with one id",
      { checkRules: [checkRule("no-todo")] },
      { checkRules: [checkRule("no-todo")] },
      'check rule "no-todo"',
    ],
    [
      "two renderers for one tracker",
      { trackers: [trackerRenderer("jira")] },
      { trackers: [trackerRenderer("jira")] },
      'tracker renderer "jira"',
    ],
    [
      "two result formats with one name",
      { resultFormats: [resultFormat("ctrf")] },
      { resultFormats: [resultFormat("ctrf")] },
      'result format "ctrf"',
    ],
    [
      "two clients for one tracker",
      { trackerClients: [trackerClient("jira")] },
      { trackerClients: [trackerClient("jira")] },
      'tracker client "jira"',
    ],
  ])("PluginConflict also covers %s", async (_, first, second, contribution) => {
    const failure = await loadFailure([plugin("first", first), plugin("second", second)]);

    expect(failure).toBeInstanceOf(PluginConflict);
    expect((failure as PluginConflict).message).toBe(
      `${contribution} comes from both plugin "first" and plugin "second"`,
    );
  });

  it("PluginApiMismatch on another major", async () => {
    const failure = await loadFailure([{ name: "old-driver", apiVersion: PLUGIN_API_VERSION + 1 }]);

    expect(failure).toBeInstanceOf(PluginApiMismatch);
    expect((failure as PluginApiMismatch).message).toContain(
      `plugin "old-driver" needs plugin API version ${PLUGIN_API_VERSION + 1}`,
    );
  });

  it("path plugin adds a step kind", async () => {
    expect(await stepKinds(["./mail.ts"])).toContain("wait-for-mail");
  });

  it("resolves a plugin package name from the project root", async () => {
    expect(await stepKinds(["fixture-plugins/mail"])).toContain("wait-for-mail");
  });

  it.each([
    ["a relative", "../cases/valid/cases/auth/login.yaml"],
    ["an absolute", fileURLToPath(new URL("./fixtures/cases", import.meta.url))],
  ])("refuses %s plugin path outside the project root", async (_, entry) => {
    const failure = await loadFailure([], [entry]);

    expect((failure as Error).message).toContain(
      `plugin path "${entry}" is outside the project root`,
    );
  });

  // from the fixture root the resolver reaches packages/core/node_modules, so ".." climbs into packages/core/test
  it.each([
    ["..", "no-such-package/../../test/support/fake-driver.ts"],
    ["backslash", "no-such-package\\..\\..\\test\\support\\fake-driver.ts"],
  ])("refuses a plugin package name with %s segments", async (_, entry) => {
    const failure = await loadFailure([], [entry]);

    expect((failure as Error).message).toBe(
      `plugin "${entry}" is neither a package name nor a path that starts with "."`,
    );
  });

  it("lets drivers with different names offer the same step kind", async () => {
    const playwright = fakeDriver({ name: "playwright", steps: [fakeStep("open")] });
    const selenium = fakeDriver({ name: "selenium", steps: [fakeStep("open")] });
    const appium = fakeDriver({ name: "appium", surface: "mobile", steps: [fakeStep("open")] });

    const registry = await PluginRegistry.load(config(), projectRoot, [
      plugin("web-drivers", { drivers: [playwright, selenium] }),
      plugin("mobile-driver", { drivers: [appium] }),
    ]);
    const open = registry.stepHandlers().filter((step) => step.kind === "open");

    expect(registry.driver("selenium")).toBe(selenium);
    expect(open).toHaveLength(1);
    expect(open[0]).toBe(playwright.steps[0]);
  });

  it.each(["use", "request", "challenge", "guided", "note", "followup", "level", "callout", "api"])(
    "refuses a plugin step of the core step kind %s",
    async (kind) => {
      const failure = await loadFailure([plugin("rogue", { steps: [fakeStep(kind)] })]);

      expect(failure).toBeInstanceOf(PluginConflict);
      expect((failure as PluginConflict).plugins).toEqual([`${BRAND.scope}/core`, "rogue"]);
    },
  );

  it("refuses a driver step of a core step kind", async () => {
    const failure = await loadFailure([
      plugin("rogue", { drivers: [fakeDriver({ steps: [fakeStep("challenge")] })] }),
    ]);

    expect(failure).toBeInstanceOf(PluginConflict);
    expect((failure as PluginConflict).plugins).toEqual([`${BRAND.scope}/core`, "rogue"]);
  });
});

describe("built-in secret providers", () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "registry-test-"));
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    await rm(root, { recursive: true, force: true });
  });

  it("registers env, dotenv and 1password", async () => {
    const registry = await PluginRegistry.load(config(), root, []);

    expect(
      registry.secretProviders(["env", "dotenv", "1password"]).map((provider) => provider.name),
    ).toEqual(["env", "dotenv", "1password"]);
  });

  it("reads dotenv values from the project's state directory", async () => {
    await mkdir(join(root, BRAND.stateDir));
    await writeFile(
      join(root, BRAND.stateDir, "secrets.env"),
      "DEMO_TOTP_SEED=fake-seed-from-dotenv\n",
    );
    const registry = await PluginRegistry.load(config(), root, []);

    const [dotenv] = registry.secretProviders(["dotenv"]);

    expect(await dotenv?.load("DEMO_TOTP_SEED")).toBe("fake-seed-from-dotenv");
  });

  // execFile cannot run the sh stub on Windows
  it.skipIf(process.platform === "win32")(
    "gives the 1password provider the refs from config",
    async () => {
      vi.stubEnv("PATH", fileURLToPath(new URL("./fixtures/bin", import.meta.url)));
      const registry = await PluginRegistry.load(
        config({ secrets: { refs: { PARTNER_HMAC_SECRET: "op://qa/partner/hmac" } } }),
        root,
        [],
      );

      const [onePassword] = registry.secretProviders(["1password"]);

      expect(await onePassword?.load("PARTNER_HMAC_SECRET")).toBe("fake-hmac-secret-from-op");
    },
  );
});

describe("PluginRegistry.secretProviders", () => {
  const defaults = [
    plugin("vault-plugin", { secretProviders: [secretProvider("vault")] }),
    plugin("cloud-plugin", { secretProviders: [secretProvider("aws"), secretProvider("gcp")] }),
  ];

  it("returns providers in the order of the names, not the order plugins registered them", async () => {
    const registry = await PluginRegistry.load(config(), projectRoot, defaults);

    expect(registry.secretProviders(["gcp", "vault"]).map((provider) => provider.name)).toEqual([
      "gcp",
      "vault",
    ]);
  });

  it("throws on an unknown provider name and lists the known ones", async () => {
    const registry = await PluginRegistry.load(config(), projectRoot, defaults);

    expect(() => registry.secretProviders(["vault", "valt"])).toThrow(
      /^unknown secret provider "valt"; known: .*\bvault\b/,
    );
  });
});

describe("PluginRegistry.strategy", () => {
  const sso = authStrategy("sso");
  const defaults = [plugin("sso-plugin", { authStrategies: [sso, authStrategy("mtls")] })];

  it("returns the strategy a plugin registered under that name", async () => {
    const registry = await PluginRegistry.load(config(), projectRoot, defaults);

    expect(registry.strategy("sso")).toBe(sso);
  });

  it("throws on an unknown strategy name and lists the known ones", async () => {
    const registry = await PluginRegistry.load(config(), projectRoot, defaults);

    expect(() => registry.strategy("ssso")).toThrow(
      /^unknown auth strategy "ssso"; known: .*\bsso\b/,
    );
  });

  it("registers the built-in strategies and caches only the credentials that come from a login", async () => {
    const registry = await PluginRegistry.load(config(), projectRoot, []);

    const cacheable = Object.fromEntries(
      ["api-key", "basic", "oauth2", "session-cookie", "hmac"].map((name) => [
        name,
        registry.strategy(name).cacheable,
      ]),
    );

    expect(cacheable).toEqual({
      "api-key": false,
      basic: false,
      oauth2: true,
      "session-cookie": true,
      hmac: false,
    });
  });
});

describe("plan checks", () => {
  const planCheck = (name: string): PlanCheck => ({ name, check: async () => ({}) });

  it("lists every registered plan check in load order", async () => {
    const [budget, quota, stock] = [planCheck("budget"), planCheck("quota"), planCheck("stock")];
    const registry = await PluginRegistry.load(config(), projectRoot, [
      plugin("first", { planChecks: [budget, quota] }),
      plugin("second", { planChecks: [stock] }),
    ]);

    expect(registry.planChecks()).toEqual([budget, quota, stock]);
  });

  it("lists none when no plugin offers one", async () => {
    expect((await PluginRegistry.load(config(), projectRoot, [])).planChecks()).toEqual([]);
  });

  it("refuses two plan checks with one name", async () => {
    const failure = await loadFailure([
      plugin("first", { planChecks: [planCheck("budget")] }),
      plugin("second", { planChecks: [planCheck("budget")] }),
    ]);

    expect(failure).toBeInstanceOf(PluginConflict);
    expect((failure as PluginConflict).message).toBe(
      'plan check "budget" comes from both plugin "first" and plugin "second"',
    );
  });
});

describe("PluginRegistry.checkRules", () => {
  it("returns the built-in rules, then the rules plugins add", async () => {
    const noTodo = checkRule("no-todo");
    const registry = await PluginRegistry.load(config(), projectRoot, [
      plugin("lint-plugin", { checkRules: [noTodo] }),
    ]);

    expect(registry.checkRules()).toEqual([...builtinRules, noTodo]);
  });

  it("refuses a plugin rule with the id of a built-in rule", async () => {
    const failure = await loadFailure([
      plugin("lint-plugin", { checkRules: [checkRule("schema")] }),
    ]);

    expect(failure).toBeInstanceOf(PluginConflict);
    expect((failure as PluginConflict).plugins).toEqual([`${BRAND.scope}/core`, "lint-plugin"]);
  });
});

describe("PluginRegistry.tracker", () => {
  const jira = trackerRenderer("jira");
  const defaults = [plugin("jira-plugin", { trackers: [jira] })];

  it("returns the renderer a plugin registered for the tracker", async () => {
    const registry = await PluginRegistry.load(config(), projectRoot, defaults);

    expect(registry.tracker("jira")).toBe(jira);
  });

  it("falls back to plain Markdown for a tracker no plugin renders", async () => {
    const passed: CaseResult = {
      runId: "20261107-100000-ab12",
      caseId: "AUTH-LOGIN-001",
      title: "Customer signs in with an email code",
      stage: "acceptance",
      env: "uat",
      target: "web",
      links: ["notion:release-notes-42"],
      status: "pass",
      checks: [],
      notes: [],
      callouts: [],
      followups: [],
      attachments: [],
      challenges: [],
      identities: ["customer"],
      seed: 7,
      values: {},
      caseValues: {},
      steps: [],
      startedAt: "2026-11-07T10:00:00.000Z",
      finishedAt: "2026-11-07T10:01:00.000Z",
      durationMs: 60_000,
    };
    const registry = await PluginRegistry.load(config(), projectRoot, defaults);

    const notion = registry.tracker("notion");

    expect(notion.tracker).toBe("notion");
    expect(notion.render(passed)).toEqual(markdownTracker("notion").render(passed));
  });
});

describe("PluginRegistry.resultFormat and trackerClient", () => {
  const ctrf = resultFormat("ctrf");
  const jira = trackerClient("jira");
  const defaults = [plugin("interop-plugin", { resultFormats: [ctrf], trackerClients: [jira] })];

  it("returns the result format and the tracker client a plugin registered", async () => {
    const registry = await PluginRegistry.load(config(), projectRoot, defaults);

    expect(registry.resultFormat("ctrf")).toBe(ctrf);
    expect(registry.trackerClient("jira")).toBe(jira);
  });

  it("throws on a name no plugin registered", async () => {
    const registry = await PluginRegistry.load(config(), projectRoot, defaults);

    expect(() => registry.resultFormat("ctfr")).toThrow('unknown result format "ctfr"');
    expect(() => registry.trackerClient("notion")).toThrow(
      'unknown tracker client "notion"; known: jira',
    );
  });

  it("registers the built-in junit and playwright-json formats", async () => {
    const registry = await PluginRegistry.load(config(), projectRoot, []);

    expect(registry.resultFormat("junit")).toBe(junitFormat);
    expect(registry.resultFormat("playwright-json")).toBe(playwrightJsonFormat);
  });

  it("refuses a plugin result format with the name of a built-in one", async () => {
    const failure = await loadFailure([
      plugin("junit-plugin", { resultFormats: [resultFormat("junit")] }),
    ]);

    expect(failure).toBeInstanceOf(PluginConflict);
    expect((failure as PluginConflict).plugins).toEqual([`${BRAND.scope}/core`, "junit-plugin"]);
  });
});

describe("PluginRegistry.kind", () => {
  it("returns a built-in kind and a kind a plugin adds", async () => {
    const registry = await PluginRegistry.load(config(), projectRoot, [
      plugin("face-plugin", { challengeKinds: [faceScan] }),
    ]);

    expect(registry.kind("totp")).toEqual({
      name: "totp",
      answer: "value",
      humanOnly: false,
      fallbackAfterTrigger: true,
    });
    expect(registry.kind("face-scan")).toBe(faceScan);
  });

  it("defines pin as a value kind and face and biometric as action kinds, none human-only", async () => {
    const registry = await PluginRegistry.load(config(), projectRoot, []);

    expect(registry.kind("pin")).toEqual({
      name: "pin",
      answer: "value",
      humanOnly: false,
      fallbackAfterTrigger: false,
    });
    for (const name of ["face", "biometric"]) {
      expect(registry.kind(name)).toEqual({
        name,
        answer: "action",
        humanOnly: false,
        fallbackAfterTrigger: true,
      });
    }
    expect(builtinKinds.filter((kind) => registry.kind(kind.name).humanOnly)).toEqual([]);
  });

  it("lists face and biometric among the known kinds", async () => {
    const registry = await PluginRegistry.load(config(), projectRoot, []);

    expect(() => registry.kind("otp-mail")).toThrow(
      'unknown challenge kind "otp-mail"; known: otp-email, otp-sms, totp, passkey, pin, face, biometric',
    );
  });
});

describe("PluginRegistry.resolverChain", () => {
  const mailpit = challengeResolver("otp-mailpit", ["otp-email"]);
  const totp = challengeResolver("totp", ["totp"]);
  const defaults = [plugin("resolver-plugin", { resolvers: [mailpit, totp] })];

  function uat(challenges: Record<string, string[]>): Environment {
    return {
      name: "uat",
      production: false,
      vars: {},
      hosts: new Set(["app.example.test"]),
      challenges,
      locale: "en",
      probes: [],
    };
  }

  it("returns the env's resolvers for the kind in config order", async () => {
    const registry = await PluginRegistry.load(config(), projectRoot, defaults);
    const chain = registry.resolverChain(
      uat({ "otp-email": ["otp-mailpit", "human"], totp: ["totp"] }),
      "otp-email",
    );

    expect(chain).toHaveLength(2);
    expect(chain[0]).toBe(mailpit);
    expect(chain[1]).toBe(humanResolver);
  });

  it("gives an empty chain for a kind the env lists no resolvers for", async () => {
    const registry = await PluginRegistry.load(config(), projectRoot, defaults);

    expect(registry.resolverChain(uat({ totp: ["totp"] }), "otp-sms")).toEqual([]);
  });

  it("refuses an automated resolver in the chain of a kind config lists as human-only", async () => {
    const registry = await PluginRegistry.load(
      config({ challenges: { humanOnly: ["totp"] } }),
      projectRoot,
      defaults,
    );

    expect(() => registry.resolverChain(uat({ totp: ["human", "totp"] }), "totp")).toThrow(
      HumanOnlyViolation,
    );
  });

  it("refuses an automated resolver for a kind that config lists under challenges.humanOnly", async () => {
    const automatableFaceScan = { ...faceScan, humanOnly: false };
    const faceBot = challengeResolver("face-bot", ["face-scan"]);
    const facePlugin = plugin("face-plugin", {
      challengeKinds: [automatableFaceScan],
      resolvers: [faceBot],
    });
    const registry = await PluginRegistry.load(
      config({ challenges: { humanOnly: ["face-scan"] } }),
      projectRoot,
      [facePlugin],
    );

    expect(registry.kind("face-scan")).toEqual({ ...automatableFaceScan, humanOnly: true });
    expect(() => registry.resolverChain(uat({ "face-scan": ["face-bot"] }), "face-scan")).toThrow(
      HumanOnlyViolation,
    );
  });

  it("throws on a resolver name no plugin registered and lists the known ones", async () => {
    const registry = await PluginRegistry.load(config(), projectRoot, defaults);

    expect(() => registry.resolverChain(uat({ "otp-email": ["otp-mailpt"] }), "otp-email")).toThrow(
      'unknown challenge resolver "otp-mailpt"; known: human, otp-mailpit, totp',
    );
  });

  it("throws on a kind name no plugin registered", async () => {
    const registry = await PluginRegistry.load(config(), projectRoot, defaults);

    expect(() =>
      registry.resolverChain(uat({ "otp-whatsapp": ["human"] }), "otp-whatsapp"),
    ).toThrow('unknown challenge kind "otp-whatsapp"');
  });

  it("throws when the env lists a resolver for a kind it does not answer", async () => {
    const registry = await PluginRegistry.load(config(), projectRoot, defaults);

    expect(() => registry.resolverChain(uat({ "otp-email": ["totp"] }), "otp-email")).toThrow(
      'env uat lists resolver "totp" for challenge otp-email, but it answers only totp',
    );
  });
});

describe("PluginRegistry.resolver", () => {
  it("returns a plugin's resolver and the core human resolver by name", async () => {
    const mailpit = challengeResolver("otp-mailpit", ["otp-email"]);
    const registry = await PluginRegistry.load(config(), projectRoot, [
      plugin("resolver-plugin", { resolvers: [mailpit] }),
    ]);

    expect(registry.resolver("otp-mailpit")).toBe(mailpit);
    expect(registry.resolver("human")).toBe(humanResolver);
  });

  it("throws on a name no plugin registered and lists the known ones", async () => {
    const registry = await PluginRegistry.load(config(), projectRoot, []);

    expect(() => registry.resolver("otp-mailpt")).toThrow(
      'unknown challenge resolver "otp-mailpt"; known: human',
    );
  });
});

describe("PluginRegistry.channel", () => {
  let runDir: string;

  beforeEach(async () => {
    runDir = await mkdtemp(join(tmpdir(), "registry-channel-test-"));
  });

  afterEach(async () => {
    await rm(runDir, { recursive: true, force: true });
  });

  it("creates the answers-file channel over the run directory it is given", async () => {
    const prompt: PersonPrompt = {
      id: "AUTH-LOGIN-001-3-pin",
      runId: "20261106-093000-a1b2",
      caseId: "AUTH-LOGIN-001",
      ask: "action",
      title: "pin challenge at step 3",
      steps: ["Enter the PIN in the app."],
      timeoutMs: 5_000,
    };
    await mkdir(join(runDir, "answers"));
    await writeFile(join(runDir, "answers", `${prompt.id}.json`), JSON.stringify({ kind: "done" }));
    const registry = await PluginRegistry.load(config(), projectRoot, []);

    const answer = await registry
      .channel("answers-file")(runDir)
      .ask(prompt, new AbortController().signal);

    expect(answer).toEqual({ kind: "done" });
    expect(await readdir(join(runDir, "prompts", "done"))).toEqual([`${prompt.id}.json`]);
  });

  it("prints terminal prompts to stderr, so stdout carries only the command's result", async () => {
    const prompt: PersonPrompt = {
      id: "AUTH-LOGIN-001-4-guided",
      runId: "20261106-093000-a1b2",
      caseId: "AUTH-LOGIN-001",
      ask: "verdict",
      title: "Log in with MPIN",
      steps: ["Enter the MPIN in the app."],
      timeoutMs: 1,
    };
    const registry = await PluginRegistry.load(config(), projectRoot, []);
    const stdout = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    try {
      // the answer depends on what stdin the test runner gives; only where the prompt went matters
      await registry
        .channel("terminal")(runDir)
        .ask(prompt, new AbortController().signal)
        .catch(() => undefined);

      expect(stderr).toHaveBeenCalledWith(
        expect.stringContaining("AUTH-LOGIN-001: Log in with MPIN"),
      );
      expect(stdout).not.toHaveBeenCalledWith(expect.stringContaining("Log in with MPIN"));
    } finally {
      stdout.mockRestore();
      stderr.mockRestore();
    }
  });

  it("throws on an unknown channel name and lists the known ones", async () => {
    const registry = await PluginRegistry.load(config(), projectRoot, [
      plugin("slack-plugin", { channels: [slackChannel()] }),
    ]);

    expect(() => registry.channel("slak")).toThrow(
      'unknown human channel "slak"; known: terminal, answers-file, slack',
    );
  });
});
