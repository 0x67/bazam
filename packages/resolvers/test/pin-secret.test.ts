import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BRAND } from "@bazam/core/brand";
import type { CheckIssue } from "@bazam/core/check";
import { PluginRegistry } from "@bazam/core/plugin";
import { loadProject, loadProjectConfig } from "@bazam/core/project";
import { defaultRedactionRules, Redactor } from "@bazam/core/redact";
import { dotenvProvider, resolveSecret, SecretMissing } from "@bazam/core/secrets";
import { afterEach, beforeEach, describe, expect, it } from "vite-plus/test";
import resolvers from "../src/index.ts";
import { pinSecretDeclared, pinSecretResolver } from "../src/pin-secret.ts";
import { builtinKind, challenge, context } from "./support.ts";

const PIN = builtinKind("pin");
// the demo app's public PIN
const DEMO_PIN = "2468";
const MISSING_PARAM = "pin-secret needs params.secret, the name of the secret that holds the PIN";

describe("pinSecretResolver", () => {
  let stateDir: string;

  beforeEach(async () => {
    stateDir = await mkdtemp(join(tmpdir(), "pin-secret-test-"));
  });

  afterEach(async () => {
    await rm(stateDir, { recursive: true, force: true });
  });

  /** A context whose secrets come only from `<stateDir>/secrets.env`, never from the real process env. */
  function dotenvContext() {
    const redactor = new Redactor(defaultRedactionRules());
    return context({ secrets: (key) => resolveSecret(key, [dotenvProvider(stateDir)], redactor) });
  }

  it("is an automated resolver of pin alone that needs no driver capability and has no arm", () => {
    expect(pinSecretResolver).toMatchObject({ name: "pin-secret", kinds: ["pin"], requires: [], automated: true });
    expect(pinSecretResolver).not.toHaveProperty("arm");
  });

  it("returns the secret params.secret names as the value", async () => {
    await writeFile(join(stateDir, "secrets.env"), `DEMO_PIN=${DEMO_PIN}\n`);

    const answer = await pinSecretResolver.resolve(challenge("pin", { secret: "DEMO_PIN" }), dotenvContext(), PIN);

    expect(answer).toEqual({ kind: "value", value: DEMO_PIN });
  });

  it("throws a configuration error naming params.secret when it is missing", async () => {
    for (const params of [{}, { secret: "" }]) {
      await expect(pinSecretResolver.resolve(challenge("pin", params), dotenvContext(), PIN)).rejects.toThrow(
        MISSING_PARAM,
      );
    }
  });

  it("rejects with SecretMissing when no provider has the secret", async () => {
    const resolving = pinSecretResolver.resolve(challenge("pin", { secret: "DEMO_PIN" }), dotenvContext(), PIN);

    await expect(resolving).rejects.toThrow(SecretMissing);
    await expect(resolving).rejects.toMatchObject({ key: "DEMO_PIN" });
  });

  it("keeps the PIN out of every error message", async () => {
    await writeFile(join(stateDir, "secrets.env"), `DEMO_PIN=${DEMO_PIN}\n`);
    const ctx = dotenvContext();
    // read the PIN first, so the failures below come after it is known
    await pinSecretResolver.resolve(challenge("pin", { secret: "DEMO_PIN" }), ctx, PIN);

    const errors = await Promise.all(
      [{}, { secret: "" }, { secret: "DEMO_PN" }].map((params) =>
        pinSecretResolver.resolve(challenge("pin", params), ctx, PIN).then(
          () => new Error("resolved"),
          (error: unknown) => error as Error,
        ),
      ),
    );

    expect(errors.map((error) => error.message)).toEqual([
      MISSING_PARAM,
      MISSING_PARAM,
      "secret DEMO_PN: no value from providers [dotenv]",
    ]);
    for (const error of errors) expect(error.message).not.toContain(DEMO_PIN);
  });
});

describe("pinSecretDeclared", () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "pin-secret-check-"));
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  /** A project whose env answers pin with `pinChain`, and whose cases and flows name declared and undeclared secrets. */
  async function issuesWith(pinChain: string): Promise<CheckIssue[]> {
    const config = [
      "envs:",
      "  uat:",
      "    production: false",
      "    hosts: [uat.app.example.test]",
      `    challenges: { pin: ${pinChain} }`,
      "secrets:",
      "  names: [DEMO_PIN]",
    ];
    const pin = (secret: string) => `{ kind: pin, fill: { id: pin-input }, params: { secret: ${secret} } }`;
    const cases = [
      "cases:",
      "  - id: BANK-PIN-001",
      "    title: Transfer confirms with a declared PIN",
      "    stage: draft",
      "    risk: low",
      "    targets: [web]",
      "    steps:",
      `      - challenge: ${pin("DEMO_PIN")}`,
      "  - id: BANK-PIN-002",
      "    title: Transfer confirms with a secret config does not declare",
      "    stage: draft",
      "    risk: low",
      "    targets: [web]",
      "    steps:",
      `      - challenge: ${pin("PARTNER_API_KEY")}`,
    ];
    const flows = [
      "flows:",
      "  - name: confirm-pin",
      "    params: [secret]",
      "    steps:",
      `      - challenge: ${pin('"${param.secret}"')}`,
      "  - name: confirm-other",
      "    steps:",
      `      - challenge: ${pin("OTHER_PIN")}`,
    ];
    await mkdir(join(root, "cases", "bank"), { recursive: true });
    await mkdir(join(root, "flows"));
    await writeFile(join(root, BRAND.configFile), `${config.join("\n")}\n`);
    await writeFile(join(root, "cases", "bank", "pin.yaml"), `${cases.join("\n")}\n`);
    await writeFile(join(root, "flows", "pin.yaml"), `${flows.join("\n")}\n`);
    const loaded = await loadProjectConfig(root);
    if (loaded.config === undefined) throw new Error(`the config has issues: ${JSON.stringify(loaded.issues)}`);
    const registry = await PluginRegistry.load(loaded.config, root, [resolvers]);
    return pinSecretDeclared.check(await loadProject(root, registry));
  }

  it("reports a pin challenge whose params.secret names a secret config does not declare", async () => {
    expect(await issuesWith("[pin-secret]")).toEqual([
      {
        ruleId: "pin-secret-declared",
        severity: "error",
        file: "cases/bank/pin.yaml",
        line: 9,
        message: `BANK-PIN-002 answers pin from secret PARTNER_API_KEY, which ${BRAND.configFile} does not declare`,
        fix: `Add PARTNER_API_KEY to secrets.names in ${BRAND.configFile}, or name a declared secret in params.secret.`,
      },
      {
        ruleId: "pin-secret-declared",
        severity: "error",
        file: "flows/pin.yaml",
        line: 6,
        message: `flow confirm-other answers pin from secret OTHER_PIN, which ${BRAND.configFile} does not declare`,
        fix: `Add OTHER_PIN to secrets.names in ${BRAND.configFile}, or name a declared secret in params.secret.`,
      },
    ]);
  });

  it("leaves pin challenges alone when no env answers pin with pin-secret", async () => {
    expect(await issuesWith("[human]")).toEqual([]);
  });
});
