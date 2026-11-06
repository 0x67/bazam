import { execFile } from "node:child_process";
import { appendFile, cp, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { BRAND } from "../src/brand.ts";
import type { ChallengeKindSpec } from "../src/challenge/index.ts";
import { builtinRules, checkProject } from "../src/check/index.ts";
import { definePlugin, PLUGIN_API_VERSION, PluginRegistry } from "../src/plugin/index.ts";
import { FIXTURES_FILE, loadProject, loadProjectConfig, type Project } from "../src/project.ts";
import { fakeDriver, fakeStep } from "./support/fake-driver.ts";

const run = promisify(execFile);
const fixture = (name: string) => fileURLToPath(new URL(`./fixtures/check/${name}`, import.meta.url));
const clean = fixture("clean");

const faceScan: ChallengeKindSpec = { name: "face-scan", answer: "action", humanOnly: true, fallbackAfterTrigger: false };
const web = definePlugin({
  name: "fake-web",
  apiVersion: PLUGIN_API_VERSION,
  drivers: [fakeDriver({ target: "web", steps: ["open", "tap", "fill", "expect"].map(fakeStep) })],
  challengeKinds: [faceScan],
});

async function registryFor(root: string): Promise<PluginRegistry> {
  const { config, issues } = await loadProjectConfig(root);
  if (config === undefined) throw new Error(`the fixture config has issues: ${JSON.stringify(issues)}`);
  return PluginRegistry.load(config, root, [web]);
}

async function load(root: string): Promise<Project> {
  return loadProject(root, await registryFor(root));
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
  ["id-domain", [["cases/auth/domain.yaml", 2, "BILLING-REFUND-001 starts with BILLING but the case is in cases/auth/"]]],
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
    "pin-human-only",
    [
      [BRAND.configFile, 9, "env uat answers human-only challenge otp-email with otp-mailpit, human"],
      [BRAND.configFile, 10, "env uat answers human-only challenge pin with human, otp-mailpit"],
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
];

describe("checkProject with the built-in rules", () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "check-test-"));
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  async function loadFailing(ruleId: string): Promise<Project> {
    await cp(clean, root, { recursive: true });
    await cp(fixture(`failing/${ruleId}`), root, { recursive: true });
    return load(root);
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
    await run("git", ["init", "--quiet", root]);
    await writeFile(join(root, ".gitignore"), `runs/\n${BRAND.stateDir}/\n`);
    const project = join(root, "examples");
    await cp(clean, project, { recursive: true });
    await rm(join(project, ".gitignore"));

    expect(checkProject(await load(project), builtinRules)).toEqual([]);
  });

  it("does not count state folders that only .git/info/exclude ignores, since teammates lack that file", async () => {
    await run("git", ["init", "--quiet", root]);
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

  it("names the kind of secret without repeating it", async () => {
    const issues = checkProject(await loadFailing("no-literal-secret"), builtinRules);

    expect(issues.map((issue) => `${issue.message} ${issue.fix}`).join("\n")).not.toMatch(/AKIA|ghp_|xoxb|eyJ|BEGIN|fake-api-key/);
  });
});

describe("loadProject", () => {
  it("loads flows, suites, fixtures and the registry's spec of each challenge kind the envs name", async () => {
    const project = await load(clean);

    expect(project.cases.map((loaded) => loaded.spec.id)).toEqual(["AUTH-LOGIN-001", "AUTH-LOGIN-002", "AUTH-LOGIN-003"]);
    expect(project.flows.get("login")).toMatchObject({ params: ["email"], source: { file: "flows/login.yaml", line: 2 } });
    expect(project.suites).toEqual(new Map([["nightly", { stages: ["regression"] }]]));
    expect(project.fixtures).toEqual({ customer: { email: "customer@example.test", name: "Fake Customer" } });
    expect([...project.retiredIds]).toEqual(["AUTH-OLD-001"]);
    expect([...project.challengeKinds.keys()]).toEqual(["otp-email", "pin", "face-scan"]);
    expect(project.challengeKinds.get("face-scan")).toBe(faceScan);
  });

  it("refuses a project whose config does not match the schema", async () => {
    const registry = await registryFor(clean);

    await expect(loadProject(fixture("invalid-config"), registry)).rejects.toThrow(`${BRAND.configFile}:2: envs.uat.production`);
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

  it("reports a missing config file", async () => {
    const root = await mkdtemp(join(tmpdir(), "check-test-"));
    try {
      const { config, issues } = await loadProjectConfig(root);

      expect(config).toBeUndefined();
      expect(issues.map((issue) => [issue.file, issue.line, issue.message])).toEqual([[BRAND.configFile, 1, `${BRAND.configFile} is missing`]]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
