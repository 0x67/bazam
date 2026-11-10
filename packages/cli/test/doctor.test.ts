import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vite-plus/test";
import { CredentialCache } from "@bazam/core/auth";
import { BRAND } from "@bazam/core/brand";
import { ExitCode } from "../src/exit.ts";
import { cli } from "./support/project.ts";

const PASSWORD = "fake-password-9f3a2c71";
const SECRET = "fake-token-4d8e1b60";
const CREDENTIAL = "fake-credential-77c1d0";

/** A path plugin with one cached and one uncached strategy and a driver with no steps. */
const PLUGIN = `const anything = { safeParse: (value) => ({ success: true, data: value }) };
const cached = {
  name: "fake-session",
  config: anything,
  cacheable: true,
  acquire: async () => ({}),
  apply: async () => {},
  secrets: (credential) => [credential.token],
};
const fixed = { ...cached, name: "fake-fixed", cacheable: false };
const driver = {
  name: "fake",
  surface: "web",
  probe: async () => new Set(),
  launch: async () => ({ capabilities: new Set(), close: async () => {} }),
  steps: [],
};
export default { name: "fake-plugin", apiVersion: 1, drivers: [driver], authStrategies: [cached, fixed] };
`;

const FIXTURES = [
  "alice:",
  "  email: alice@example.test",
  "  mobilePhone: '+447700900123'",
  `  password: ${PASSWORD}`,
  "bob:",
  "  email: bob@example.test",
  "  phone: '+447700900124'",
  "",
].join("\n");

let root: string;

async function write(path: string, text: string): Promise<void> {
  await mkdir(dirname(join(root, path)), { recursive: true });
  await writeFile(join(root, path), text);
}

function config(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    envs: {
      demo: { production: false, hosts: ["app.example.test"] },
      prod: { production: true, hosts: ["app.example.test"] },
    },
    targets: { t: { driver: "fake" } },
    plugins: ["./fake-plugin.mjs"],
    secrets: { names: ["APP_TOKEN"] },
    roles: { tester: { identities: ["bob"] } },
    identities: {
      alice: { fixture: "alice", auth: { web: { strategy: "fake-session", with: {} } } },
      bob: { fixture: "bob", auth: { web: { strategy: "fake-fixed", with: {} } } },
    },
    ...overrides,
  });
}

function cases(...steps: unknown[]): string {
  const body = {
    cases: [
      {
        id: "DOC-ONE-001",
        title: "A case that names identities",
        stage: "acceptance",
        risk: "low",
        links: ["jira:DEMO-1"],
        targets: ["t"],
        steps,
      },
    ],
  };
  return JSON.stringify(body);
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "cli-doctor-"));
  await write(BRAND.configFile, config());
  await write("fake-plugin.mjs", PLUGIN);
  await write("fixtures/identities.local.yaml", FIXTURES);
  await write("cases/doc/cases.yaml", cases({ note: "act", as: "alice" }, { note: "act", as: "tester" }));
  await write(`${BRAND.stateDir}/secrets.env`, `APP_TOKEN=${SECRET}\n`);
  await chmod(join(root, BRAND.stateDir, "secrets.env"), 0o600);
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

const doctor = (...extra: string[]) => cli(["doctor", "--env", "demo", ...extra], root);

describe("doctor", () => {
  it("exits 0 with no problem and prints no fixture or secret value", async () => {
    const { code, stdout, stderr } = await doctor();

    expect(code, stdout + stderr).toBe(ExitCode.Pass);
    expect(stdout).toContain("APP_TOKEN: held by dotenv");
    expect(stdout).toContain("0 problems");
    for (const value of [PASSWORD, SECRET, "alice@example.test", "+447700900123"]) expect(stdout).not.toContain(value);
  });

  it("covers the identities of a role", async () => {
    const { stdout } = await doctor();

    expect(stdout).toContain("bob.phone: phone, country United Kingdom");
  });

  it("names the country of a phone field and gives only the length of a password", async () => {
    const { stdout } = await doctor();

    expect(stdout).toContain("alice.mobilePhone: phone, country United Kingdom");
    expect(stdout).toContain(`alice.password: ${PASSWORD.length} characters`);
  });

  it("reports a secret that no provider holds, with its fix", async () => {
    await rm(join(root, BRAND.stateDir, "secrets.env"));

    const { code, stdout } = await doctor();

    expect(code).toBe(ExitCode.Fail);
    expect(stdout).toContain("APP_TOKEN: no provider holds it");
    expect(stdout).toContain(`fix: set APP_TOKEN in ${join(root, BRAND.stateDir, "secrets.env")} or the environment`);
    expect(stdout).toContain("1 problem");
  });

  it("reports an empty secret as not held, as a run does", async () => {
    await write(`${BRAND.stateDir}/secrets.env`, "APP_TOKEN=\n");
    await chmod(join(root, BRAND.stateDir, "secrets.env"), 0o600);

    const { code, stdout } = await doctor();

    expect(code).toBe(ExitCode.Fail);
    expect(stdout).toContain("APP_TOKEN: no provider holds it");
  });

  it("keeps the secrets and their fix in --json output", async () => {
    await rm(join(root, BRAND.stateDir, "secrets.env"));
    await write("fixtures/identities.local.yaml", FIXTURES);

    const { code, stdout } = await doctor("--json");

    expect(code).toBe(ExitCode.Fail);
    const doc = JSON.parse(stdout) as { Secrets: { text: string; fix?: string }[] };
    expect(doc.Secrets).toEqual([
      {
        text: "APP_TOKEN: no provider holds it",
        fix: `set APP_TOKEN in ${join(root, BRAND.stateDir, "secrets.env")} or the environment`,
      },
    ]);
    for (const value of [PASSWORD, SECRET, "alice@example.test"]) expect(stdout).not.toContain(value);
  });

  it("does not print the line of a malformed fixtures file", async () => {
    await write("fixtures/identities.local.yaml", `alice:\n  email: [alice@example.test\n  password: ${PASSWORD}\n`);

    const { code, stdout, stderr } = await doctor();

    expect(code).toBe(ExitCode.CouldNotStart);
    expect(stderr).toContain("fixtures/identities.local.yaml is not valid YAML at line");
    expect(stdout + stderr).not.toContain(PASSWORD);
  });

  it.skipIf(process.platform === "win32")("reports a secrets.env that others can read", async () => {
    await chmod(join(root, BRAND.stateDir, "secrets.env"), 0o644);

    const { code, stdout } = await doctor();

    expect(code).toBe(ExitCode.Fail);
    expect(stdout).toContain(`fix: chmod 600 ${join(root, BRAND.stateDir, "secrets.env")}`);
  });

  it("reports an identity with no fixture entry", async () => {
    await write("fixtures/identities.local.yaml", "bob:\n  phone: '+447700900124'\n");

    const { code, stdout } = await doctor();

    expect(code).toBe(ExitCode.Fail);
    expect(stdout).toContain("alice: no fixture entry alice");
  });

  it("reports an email off example domains and a phone that does not parse", async () => {
    await write(
      "fixtures/identities.local.yaml",
      FIXTURES.replace("alice@example.test", "alice@corp.test").replace("+447700900124", "12"),
    );

    const { code, stdout } = await doctor();

    expect(code).toBe(ExitCode.Fail);
    expect(stdout).toContain("alice.email: email, not on an example domain");
    expect(stdout).toContain("bob.phone: not a phone number");
    expect(stdout).not.toContain("corp.test");
  });

  it("reads a cached credential as cached and a fixed one as static", async () => {
    await new CredentialCache(join(root, BRAND.stateDir, "credentials")).save(
      { env: "demo", identity: "alice", surface: "web", strategy: "fake-session" },
      { token: CREDENTIAL },
      new Date(Date.now() + 3_600_000),
    );

    const { stdout } = await doctor();

    expect(stdout).toContain("alice/web: credential cached");
    expect(stdout).toContain("bob/web: credential static");
    expect(stdout).not.toContain(CREDENTIAL);
  });

  it("leaves out the identities of a case that does not run in a production env", async () => {
    const { stdout } = await cli(["doctor", "--env", "prod"], root);

    expect(stdout).not.toContain("alice");
  });

  it("exits 2 for an unknown or missing env", async () => {
    expect((await cli(["doctor", "--env", "nope"], root)).code).toBe(ExitCode.CouldNotStart);
    expect((await cli(["doctor"], root)).code).toBe(ExitCode.CouldNotStart);
  });
});
