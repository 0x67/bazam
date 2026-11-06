import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Redactor, defaultRedactionRules } from "../src/redact/index.ts";
import {
  SecretMissing,
  dotenvProvider,
  envProvider,
  onePasswordProvider,
  resolveSecret,
  type SecretProvider,
} from "../src/secrets/index.ts";

const stubBin = fileURLToPath(new URL("./fixtures/bin", import.meta.url));

// records the keys it was asked for
function recordingProvider(name: string, values: Record<string, string>): SecretProvider & { asked: string[] } {
  const asked: string[] = [];
  return {
    name,
    asked,
    async load(key) {
      asked.push(key);
      return values[key];
    },
  };
}

let stateDir: string;

beforeEach(async () => {
  stateDir = await mkdtemp(join(tmpdir(), "secrets-test-"));
});

afterEach(async () => {
  vi.unstubAllEnvs();
  await rm(stateDir, { recursive: true, force: true });
});

describe("resolveSecret", () => {
  it("first provider with a value wins", async () => {
    await writeFile(
      join(stateDir, "secrets.env"),
      "DEMO_TOTP_SEED=fake-seed-from-dotenv\nPARTNER_KEY_ID=fake-key-id-from-dotenv\nDEMO_API_KEY=\n",
    );
    vi.stubEnv("DEMO_TOTP_SEED", "fake-seed-from-env");
    vi.stubEnv("PARTNER_KEY_ID", "");
    vi.stubEnv("DEMO_API_KEY", undefined);
    const fallback = recordingProvider("fallback", { DEMO_API_KEY: "fake-api-key-from-fallback", DEMO_TOTP_SEED: "unused" });
    const providers = [envProvider, dotenvProvider(stateDir), fallback];
    const redactor = new Redactor(defaultRedactionRules());

    expect(await resolveSecret("DEMO_TOTP_SEED", providers, redactor)).toBe("fake-seed-from-env");
    expect(await resolveSecret("PARTNER_KEY_ID", providers, redactor)).toBe("fake-key-id-from-dotenv");
    expect(await resolveSecret("DEMO_API_KEY", providers, redactor)).toBe("fake-api-key-from-fallback");
    expect(fallback.asked).toEqual(["DEMO_API_KEY"]);
  });

  it("throws SecretMissing naming the key and the providers when none has a value", async () => {
    const providers = [recordingProvider("first", {}), recordingProvider("second", { OTHER: "fake-other" })];

    const error = await resolveSecret("DEMO_TOTP_SEED", providers, new Redactor(defaultRedactionRules())).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(SecretMissing);
    expect(error).toMatchObject({ key: "DEMO_TOTP_SEED", message: expect.stringContaining("[first, second]") });
  });

  it("masks returned values", async () => {
    const redactor = new Redactor(defaultRedactionRules());

    const value = await resolveSecret("DEMO_API_KEY", [recordingProvider("fixed", { DEMO_API_KEY: "fake-api-key" })], redactor);

    expect(redactor.text(`X-Api-Key: ${value}`)).toBe("X-Api-Key: [redacted]");
  });

  it("asks the providers once per key for the same redactor and again for a new one", async () => {
    const provider = recordingProvider("fixed", { DEMO_API_KEY: "fake-api-key" });
    const firstRun = new Redactor(defaultRedactionRules());
    const secondRun = new Redactor(defaultRedactionRules());

    await resolveSecret("DEMO_API_KEY", [provider], firstRun);
    await resolveSecret("DEMO_API_KEY", [provider], firstRun);
    const value = await resolveSecret("DEMO_API_KEY", [provider], secondRun);

    expect(provider.asked).toEqual(["DEMO_API_KEY", "DEMO_API_KEY"]);
    expect(secondRun.text(value)).toBe("[redacted]");
  });
});

describe("dotenvProvider", () => {
  it("returns no value when secrets.env does not exist", async () => {
    expect(await dotenvProvider(stateDir).load("DEMO_TOTP_SEED")).toBeUndefined();
  });
});

// execFile cannot run the sh stub on Windows
describe.skipIf(process.platform === "win32")("onePasswordProvider", () => {
  beforeEach(() => {
    vi.stubEnv("PATH", stubBin);
  });

  it("reads 1Password refs through op", async () => {
    const provider = onePasswordProvider({ PARTNER_HMAC_SECRET: "op://qa/partner/hmac" });

    expect(await provider.load("PARTNER_HMAC_SECRET")).toBe("fake-hmac-secret-from-op");
    expect(await provider.load("DEMO_TOTP_SEED")).toBeUndefined();
  });

  it("throws SecretMissing with the op error when op read fails", async () => {
    const provider = onePasswordProvider({ PARTNER_KEY_ID: "op://qa/partner/missing" });

    const error = await provider.load("PARTNER_KEY_ID").catch((e: unknown) => e);

    expect(error).toBeInstanceOf(SecretMissing);
    expect(error).toMatchObject({ key: "PARTNER_KEY_ID", message: expect.stringContaining("item not found") });
  });
});
