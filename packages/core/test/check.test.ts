import { execFile } from "node:child_process";
import { appendFile, cp, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { BRAND } from "../src/brand.ts";
import { humanResolver, type ChallengeKindSpec, type ChallengeResolver } from "../src/challenge/index.ts";
import { builtinRules, checkProject, type CheckIssue } from "../src/check/index.ts";
import { definePlugin, PLUGIN_API_VERSION, PluginRegistry, type PluginManifest } from "../src/plugin/index.ts";
import { FIXTURES_FILE, loadProject, loadProjectConfig, type Project } from "../src/project.ts";
import { fakeDriver, fakeStep } from "./support/fake-driver.ts";

const run = promisify(execFile);
// a git hook exports variables such as GIT_DIR, which would point these git calls at the repository running the hook
const gitEnv = Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.startsWith("GIT_")));
const git = (args: readonly string[]) => run("git", args, { env: gitEnv });
const fixture = (name: string) => fileURLToPath(new URL(`./fixtures/check/${name}`, import.meta.url));
const clean = fixture("clean");

const faceScan: ChallengeKindSpec = {
  name: "face-scan",
  answer: "action",
  humanOnly: true,
  fallbackAfterTrigger: false,
};
const web = definePlugin({
  name: "fake-web",
  apiVersion: PLUGIN_API_VERSION,
  drivers: [fakeDriver({ name: "playwright", steps: ["open", "tap", "fill", "expect"].map(fakeStep) })],
  challengeKinds: [faceScan],
});

function fakeResolver(name: string, kinds: readonly string[], automated: boolean): ChallengeResolver {
  return { name, kinds, requires: [], automated, resolve: async () => undefined };
}
const otpMailpit = fakeResolver("otp-mailpit", ["otp-email"], true);
const resolvers = definePlugin({
  name: "fake-resolvers",
  apiVersion: PLUGIN_API_VERSION,
  // ops-pager pages a person on call, so like human it is not automated
  resolvers: [otpMailpit, fakeResolver("face-bot", ["face-scan"], true), fakeResolver("ops-pager", ["*"], false)],
});

async function registryFor(
  root: string,
  plugins: readonly PluginManifest[] = [web, resolvers],
): Promise<PluginRegistry> {
  const { config, issues } = await loadProjectConfig(root);
  if (config === undefined) throw new Error(`the fixture config has issues: ${JSON.stringify(issues)}`);
  return PluginRegistry.load(config, root, plugins);
}

async function load(root: string, plugins?: readonly PluginManifest[]): Promise<Project> {
  return loadProject(root, await registryFor(root, plugins));
}

/** [file, line, part of the message] of each issue, in the order checkProject reports them. */
type Expected = [string, number, string][];

// each failing fixture holds only the files that differ from the clean project
const failing: [string, Expected][] = [
  [
    "schema",
    [
      ["cases/auth/schema.yaml", 7, "tagz"],
      ["flows/more.yaml", 2, "flow login is already defined at flows/login.yaml:2"],
      ["flows/schema.yaml", 3, "flows[0].steps"],
      ["suites.yaml", 2, 'smoke: Unrecognized key: "tag"'],
      [BRAND.configFile, 10, 'unknown challenge kind "otp-whatsapp"'],
      [BRAND.configFile, 26, 'unknown challenge kind "face-scn"'],
    ],
  ],
  ["id-format", [["cases/auth/format.yaml", 2, "id"]]],
  [
    "id-domain",
    [["cases/auth/domain.yaml", 2, "BILLING-REFUND-001 starts with BILLING but the case is in cases/auth/"]],
  ],
  ["id-unique", [["cases/auth/unique.yaml", 2, "AUTH-LOGIN-001 is already used at cases/auth/login.yaml:2"]]],
  ["id-retired", [["cases/auth/retired.yaml", 2, "AUTH-OLD-001 is retired"]]],
  ["case-has-check", [["cases/auth/unchecked.yaml", 2, "AUTH-UNCHECKED-001 has no check"]]],
  [
    "stage-link",
    [
      ["cases/auth/unlinked.yaml", 2, "AUTH-UNLINKED-001 is an acceptance case with no link"],
      ["cases/auth/unlinked.yaml", 9, "AUTH-UNLINKED-002 is a once case with no link"],
    ],
  ],
  [
    "flow-expands",
    [
      ["cases/auth/flows.yaml", 8, "flow logn: no such flow"],
      ["cases/auth/flows.yaml", 9, "flow login: missing parameter email"],
      ["cases/auth/flows.yaml", 10, "flow cycle: loop-a -> loop-b -> loop-a"],
      ["cases/auth/flows.yaml", 11, "flow login: a challenge trigger runs one step, and the flow expands to 3"],
    ],
  ],
  [
    "placeholder-resolves",
    [
      ["cases/auth/placeholders.yaml", 8, "${env.ADMIN_URL} is not a var of env uat, prod"],
      ["cases/auth/placeholders.yaml", 9, "${secret.PARTNER_KEY} names a secret"],
      ["cases/auth/placeholders.yaml", 10, `${FIXTURES_FILE} has no phone for identity customer`],
      ["cases/auth/placeholders.yaml", 11, `${FIXTURES_FILE} has no email for identity partner`],
      ["cases/auth/placeholders.yaml", 12, `email of identity customer in ${FIXTURES_FILE} is not a phone number`],
      [BRAND.configFile, 27, "${secret.PARTNER_HMAC_SECRT} names a secret"],
      [BRAND.configFile, 28, "${env.APP_URLL} is not a var of env uat, prod"],
    ],
  ],
  [
    "no-literal-secret",
    [
      ["cases/auth/secrets.yaml", 8, "an AWS access key id"],
      ["cases/auth/secrets.yaml", 9, "a GitHub token"],
      ["cases/auth/secrets.yaml", 10, "a Slack token"],
      ["cases/auth/secrets.yaml", 11, "a JWT"],
      ["cases/auth/secrets.yaml", 12, "a private key block"],
      ["cases/auth/secrets.yaml", 13, "a 38-character string with 4.7 bits of entropy per character"],
    ],
  ],
  ["fixture-domain", [["fixtures/identities.example.yaml", 5, "example.invalid"]]],
  [
    "human-only-chain",
    [
      [BRAND.configFile, 9, "env uat answers human-only challenge otp-email with otp-mailpit, human"],
      [BRAND.configFile, 15, "env prod answers human-only challenge face-scan with face-bot"],
    ],
  ],
  [
    "prod-safe",
    [
      ["cases/auth/prod.yaml", 10, "AUTH-PROD-001 is prod_safe but its DELETE request does not set write: true"],
      ["cases/auth/prod.yaml", 14, "its POST request"],
      ["cases/auth/prod.yaml", 16, "its PATCH request"],
    ],
  ],
  ["state-ignored", [[".gitignore", 1, `.gitignore does not ignore ${BRAND.stateDir}/`]]],
  [
    "selector-test-id",
    [
      ["cases/auth/selectors.yaml", 8, 'selector { css: ".sign-in > button" }'],
      ["cases/auth/selectors.yaml", 11, 'selector { text: "Welcome back" }'],
    ],
  ],
  [
    "external-case-shape",
    [
      ["cases/auth/external.yaml", 12, "AUTH-EXT-002 runs on runner target shop-chrome but has steps"],
      ["cases/auth/external.yaml", 19, "AUTH-EXT-003 runs on runner target shop-chrome but has checks"],
      ["cases/auth/external.yaml", 25, "AUTH-EXT-004 lists runner targets (shop-chrome) and driver targets (web)"],
    ],
  ],
  ["runner-format-known", [[BRAND.configFile, 26, "runner shop-suite uses format ctrf, which no plugin registers"]]],
  [
    "runner-mapping-valid",
    [
      [BRAND.configFile, 32, "mapping file interop/api-suite.yaml of runner api-suite is missing"],
      ["interop/old-suite.yaml", 1, "tests: Invalid input: expected record"],
      ["interop/shop-suite.yaml", 3, 'test "CartTest › oldTest" maps to AUTH-GONE-001, which no case declares'],
      [
        "interop/shop-suite.yaml",
        4,
        'test "LoginTest › signsIn" maps to case AUTH-LOGIN-001, which does not run on a target of runner shop-suite',
      ],
    ],
  ],
];

describe("checkProject with the built-in rules", () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "check-test-"));
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  async function loadFailing(ruleId: string, plugins?: readonly PluginManifest[]): Promise<Project> {
    await cp(clean, root, { recursive: true });
    await cp(fixture(`failing/${ruleId}`), root, { recursive: true });
    return load(root, plugins);
  }

  it("finds nothing in the clean project", async () => {
    expect(checkProject(await load(clean), builtinRules)).toEqual([]);
  });

  it("has a failing fixture for every built-in rule", () => {
    expect(failing.map(([ruleId]) => ruleId)).toEqual(builtinRules.map((rule) => rule.id));
  });

  it.each(failing)("%s reports its failing fixture with file, line, message and fix", async (ruleId, expected) => {
    const issues = checkProject(await loadFailing(ruleId), builtinRules);
    const severity = ruleId === "selector-test-id" ? "warning" : "error";

    expect(issues.map((issue) => [issue.ruleId, issue.severity, issue.file, issue.line])).toEqual(
      expected.map(([file, line]) => [ruleId, severity, file, line]),
    );
    issues.forEach((issue, index) => {
      expect(issue.message).toContain(expected[index]?.[2]);
      expect(issue.fix).not.toBe("");
    });
  });

  it("leaves an external case with no steps and no checks out of case-has-check, but not a native one", async () => {
    await cp(clean, root, { recursive: true });
    await cp(fixture("failing/external-case-shape/bazam.config.yaml"), join(root, BRAND.configFile));
    const cases = ["shop-chrome", "web"].map((target, index) =>
      [
        `  - id: AUTH-BARE-00${index + 1}`,
        `    title: Case on ${target} with nothing to check`,
        "    stage: draft",
        "    risk: low",
        `    targets: [${target}]`,
      ].join("\n"),
    );
    await writeFile(join(root, "cases/auth/bare.yaml"), `cases:\n${cases.join("\n")}\n`);

    expect(checkProject(await load(root), builtinRules).map((issue) => [issue.ruleId, issue.message])).toEqual([
      ["case-has-check", "AUTH-BARE-002 has no check"],
    ]);
  });

  it("leaves a runner mapping file out of no-literal-secret, since its keys are test titles", async () => {
    await cp(clean, root, { recursive: true });
    await cp(fixture("failing/runner-mapping-valid"), root, { recursive: true });
    await writeFile(
      join(root, "interop/shop-suite.yaml"),
      'tests:\n  "com.shop.PaymentTest › PaymentGatewayRejectsExpiredVisaCard": AUTH-EXT-001\n',
    );

    const issues = checkProject(await load(root), builtinRules);

    expect(
      issues.filter((issue) => issue.ruleId === "no-literal-secret" && issue.file === "interop/shop-suite.yaml"),
    ).toEqual([]);
  });

  it("tells a trigger whose flow has several steps to name a one-step flow", async () => {
    const issues = checkProject(await loadFailing("flow-expands"), builtinRules);

    expect(issues.find((issue) => issue.line === 11)?.fix).toBe(
      "Point the trigger or observe at a flow with exactly one step, or write that step in place.",
    );
  });

  it("checks emails only in the identities fixtures file, so a case may name a real address", async () => {
    await cp(clean, root, { recursive: true });
    const support = [
      "cases:",
      "  - id: AUTH-HELP-001",
      "    title: Help page names the support address",
      "    stage: draft",
      "    risk: low",
      "    targets: [web]",
      "    steps:",
      "      - expect: { visible: { id: help } }",
      "      - note: the page shows support@example.invalid",
    ];
    await writeFile(join(root, "cases/auth/help.yaml"), `${support.join("\n")}\n`);

    expect(checkProject(await load(root), builtinRules)).toEqual([]);
  });

  it("accepts a phone form of a fixture field that holds a possible number", async () => {
    await cp(clean, root, { recursive: true });
    await writeFile(join(root, FIXTURES_FILE), 'customer:\n  email: customer@example.test\n  phone: "+447700900123"\n');
    const phone = [
      "cases:",
      "  - id: AUTH-PHONE-001",
      "    title: Profile saves the phone number",
      "    stage: draft",
      "    risk: low",
      "    targets: [web]",
      "    steps:",
      '      - fill: { field: { id: country }, value: "${identity.customer.phone.countryName} (${identity.customer.phone.countryCode})" }',
      '      - fill: { field: { id: number }, value: "${identity.customer.phone.domestic}" }',
      "      - expect: { visible: { id: saved } }",
    ];
    await writeFile(join(root, "cases/auth/phone.yaml"), `${phone.join("\n")}\n`);

    expect(checkProject(await load(root), builtinRules)).toEqual([]);
  });

  it("accepts state folders that a parent folder's .gitignore ignores", async () => {
    await git(["init", "--quiet", root]);
    await writeFile(join(root, ".gitignore"), `runs/\n${BRAND.stateDir}/\n`);
    const project = join(root, "examples");
    await cp(clean, project, { recursive: true });
    await rm(join(project, ".gitignore"));

    expect(checkProject(await load(project), builtinRules)).toEqual([]);
  });

  it("reads the project's own repository when GIT_DIR names another one, as a git hook in a worktree does", async () => {
    const other = join(root, "other");
    await git(["init", "--quiet", root]);
    await git(["init", "--quiet", other]);
    await writeFile(join(root, ".gitignore"), `runs/\n${BRAND.stateDir}/\nother/\n`);
    const project = join(root, "examples");
    await cp(clean, project, { recursive: true });
    await rm(join(project, ".gitignore"));
    vi.stubEnv("GIT_DIR", join(other, ".git"));
    try {
      expect(checkProject(await load(project), builtinRules)).toEqual([]);
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("does not count state folders that only .git/info/exclude ignores, since teammates lack that file", async () => {
    await git(["init", "--quiet", root]);
    await cp(clean, root, { recursive: true });
    await rm(join(root, ".gitignore"));
    await mkdir(join(root, ".git", "info"), { recursive: true });
    await appendFile(join(root, ".git", "info", "exclude"), `runs/\n${BRAND.stateDir}/\n`);

    const issues = checkProject(await load(root), builtinRules);

    expect(issues.map((issue) => [issue.ruleId, issue.message])).toEqual([
      ["state-ignored", ".gitignore does not ignore runs/"],
      ["state-ignored", `.gitignore does not ignore ${BRAND.stateDir}/`],
    ]);
  });

  describe("human-only-chain failing fixture", () => {
    async function chainIssues(plugins?: readonly PluginManifest[]): Promise<CheckIssue[]> {
      const issues = checkProject(await loadFailing("human-only-chain", plugins), builtinRules);
      return issues.filter((issue) => issue.ruleId === "human-only-chain");
    }

    it("reports an automated resolver in the chain of a kind config lists as human-only", async () => {
      expect((await chainIssues()).find((issue) => issue.line === 9)).toMatchObject({
        message: "env uat answers human-only challenge otp-email with otp-mailpit, human",
        fix: "Set otp-email to [human] under the challenges of env uat.",
      });
    });

    it("reports an automated resolver in the chain of a plugin kind that is human-only", async () => {
      expect((await chainIssues()).find((issue) => issue.line === 15)).toMatchObject({
        message: "env prod answers human-only challenge face-scan with face-bot",
        fix: "Set face-scan to [human] under the challenges of env prod.",
      });
    });

    it("accepts a chain of resolvers that are not automated", async () => {
      // line 10 gives face-scan [human, ops-pager], and line 15 gives pin [pin-secret], since pin is not human-only
      expect((await chainIssues()).map((issue) => [issue.line, issue.message])).toEqual([
        [9, "env uat answers human-only challenge otp-email with otp-mailpit, human"],
        [15, "env prod answers human-only challenge face-scan with face-bot"],
      ]);
    });

    it("counts a resolver no plugin registered as automated", async () => {
      expect((await chainIssues([web])).map((issue) => [issue.line, issue.message])).toEqual([
        [9, "env uat answers human-only challenge otp-email with otp-mailpit, human"],
        [10, "env uat answers human-only challenge face-scan with human, ops-pager"],
        [15, "env prod answers human-only challenge face-scan with face-bot"],
      ]);
    });
  });

  it("names the kind of secret without repeating it", async () => {
    const issues = checkProject(await loadFailing("no-literal-secret"), builtinRules);

    expect(issues.map((issue) => `${issue.message} ${issue.fix}`).join("\n")).not.toMatch(
      /AKIA|ghp_|xoxb|eyJ|BEGIN|fake-api-key/,
    );
  });
});

describe("loadProject", () => {
  it("loads flows, suites, fixtures and the registry's spec of each challenge kind the envs name", async () => {
    const project = await load(clean);

    expect(project.cases.map((loaded) => loaded.spec.id)).toEqual([
      "AUTH-LOGIN-001",
      "AUTH-LOGIN-002",
      "AUTH-LOGIN-003",
    ]);
    expect(project.flows.get("login")).toMatchObject({
      params: ["email"],
      source: { file: "flows/login.yaml", line: 2 },
    });
    expect(project.suites).toEqual(new Map([["nightly", { stages: ["regression"] }]]));
    expect(project.fixtures).toEqual({ customer: { email: "customer@example.test", name: "Fake Customer" } });
    expect([...project.retiredIds]).toEqual(["AUTH-OLD-001"]);
    expect([...project.challengeKinds.keys()]).toEqual(["otp-email", "pin", "face-scan"]);
    expect(project.challengeKinds.get("face-scan")).toBe(faceScan);
    expect(project.resolvers).toEqual(
      new Map([
        ["otp-mailpit", otpMailpit],
        ["human", humanResolver],
      ]),
    );
  });

  it("keeps the mapping files that loaded and the runner formats a plugin registered", async () => {
    const root = await mkdtemp(join(tmpdir(), "check-test-"));
    try {
      await cp(clean, root, { recursive: true });
      await cp(fixture("failing/runner-mapping-valid"), root, { recursive: true });

      const project = await load(root);

      expect(project.mappings).toEqual(
        new Map([
          [
            "shop-suite",
            {
              tests: {
                "CartTest › keepsItems": "AUTH-EXT-001",
                "CartTest › oldTest": "AUTH-GONE-001",
                "LoginTest › signsIn": "AUTH-LOGIN-001",
              },
            },
          ],
        ]),
      );
      expect([...project.resultFormats]).toEqual(["junit"]);
      expect(project.files.has("interop/shop-suite.yaml")).toBe(true);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("leaves out of resolvers a name no plugin registered", async () => {
    expect([...(await load(clean, [web])).resolvers.keys()]).toEqual(["human"]);
  });

  it("refuses a project whose config does not match the schema", async () => {
    const registry = await registryFor(clean);

    await expect(loadProject(fixture("invalid-config"), registry)).rejects.toThrow(
      `${BRAND.configFile}:2: envs.uat.production`,
    );
  });
});

describe("loadProjectConfig", () => {
  it("reports config schema issues on the line of the offending key", async () => {
    const { config, issues } = await loadProjectConfig(fixture("invalid-config"));

    expect(config).toBeUndefined();
    expect(issues.map((issue) => [issue.ruleId, issue.file, issue.line, issue.message])).toEqual([
      ["schema", BRAND.configFile, 2, "envs.uat.production: Invalid input: expected boolean, received undefined"],
      ["schema", BRAND.configFile, 5, 'Unrecognized key: "identity"'],
    ]);
  });

  it("reports a target without a driver on the target's line", async () => {
    const root = await mkdtemp(join(tmpdir(), "check-test-"));
    try {
      await writeFile(
        join(root, BRAND.configFile),
        "envs: {}\ntargets:\n  web: { browser: chromium, headless: true }\n",
      );

      const { config, issues } = await loadProjectConfig(root);

      expect(config).toBeUndefined();
      expect(issues.map((issue) => [issue.file, issue.line, issue.message])).toEqual([
        [BRAND.configFile, 3, "targets.web: a target needs driver or runner"],
      ]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("reads the redaction entry and reports a pattern that is not a regular expression on its line", async () => {
    const root = await mkdtemp(join(tmpdir(), "check-test-"));
    try {
      const redaction = [
        "envs: {}",
        "redaction:",
        "  screenshotSelectors: ['#card']",
        "  patterns:",
        "    - 'ACCT-\\d+'",
      ];
      await writeFile(join(root, BRAND.configFile), `${redaction.join("\n")}\n`);

      expect((await loadProjectConfig(root)).config?.redaction).toEqual({
        patterns: ["ACCT-\\d+"],
        screenshotSelectors: ["#card"],
      });

      await writeFile(join(root, BRAND.configFile), `${[...redaction, "    - '(unclosed'"].join("\n")}\n`);
      const { config, issues } = await loadProjectConfig(root);

      expect(config).toBeUndefined();
      expect(issues.map((issue) => [issue.file, issue.line, issue.message])).toEqual([
        [BRAND.configFile, 6, expect.stringMatching(/^redaction\.patterns\[1\]: not a regular expression: /)],
      ]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("reports a missing config file", async () => {
    const root = await mkdtemp(join(tmpdir(), "check-test-"));
    try {
      const { config, issues } = await loadProjectConfig(root);

      expect(config).toBeUndefined();
      expect(issues.map((issue) => [issue.file, issue.line, issue.message])).toEqual([
        [BRAND.configFile, 1, `${BRAND.configFile} is missing`],
      ]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
