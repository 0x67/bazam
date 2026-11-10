import { rm } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vite-plus/test";
import { z } from "zod";
import { CredentialCache, defineAuthStrategy } from "../src/auth/index.ts";
import { BRAND } from "../src/brand.ts";
import { definePlugin, PLUGIN_API_VERSION } from "../src/plugin/index.ts";
import { defaultRedactionRules, Redactor } from "../src/redact/index.ts";
import { loadScanValues } from "../src/scan/index.ts";
import { loadTestProject } from "./support/project.ts";

const PIN = "fake-pin-9082";
const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

const plugin = definePlugin({
  name: "test-scan",
  apiVersion: PLUGIN_API_VERSION,
  secretProviders: [{ name: "fixed", load: async (key) => (key === "DEMO_PIN" ? PIN : undefined) }],
  authStrategies: [
    defineAuthStrategy<unknown, { token: string }>({
      name: "bearer",
      config: z.unknown(),
      cacheable: true,
      acquire: async () => ({ token: "unused" }),
      apply: async () => {},
      secrets: (credential) => [credential.token],
    }),
  ],
});

async function load(redaction: Record<string, unknown> = {}) {
  const { root, project, registry } = await loadTestProject(
    {
      [BRAND.configFile]: {
        envs: {
          demo: { production: false, vars: {}, hosts: ["app.example.test"] },
          other: { production: false, vars: {}, hosts: ["app.example.test"] },
        },
        targets: {},
        secrets: { providers: ["fixed"], names: ["DEMO_PIN", "DEMO_GONE"] },
        identities: { alice: { fixture: "alice", auth: {} } },
        redaction,
      },
      "fixtures/identities.local.yaml": {
        alice: { email: "alice@example.test", phone: "+447700900123", badge: "BADGE-4417" },
      },
    },
    [plugin],
  );
  roots.push(root);
  const cache = new CredentialCache(join(root, BRAND.stateDir, "credentials"));
  const loaded = () =>
    loadScanValues({
      project,
      registry,
      env: project.config.envs["demo"]!,
      redactor: new Redactor(defaultRedactionRules()),
      around: new Date("2026-11-07T10:15:00Z"),
    });
  return { cache, loaded };
}

const kinds = (values: readonly { kind: string }[]) => [...new Set(values.map((entry) => entry.kind))];

describe("loadScanValues", () => {
  it("leaves out a field that redaction.shown lists", async () => {
    const { loaded } = await load({ shown: ["email", "badge"] });

    expect(kinds((await loaded()).values)).toEqual(["fixture alice.phone", "secret DEMO_PIN"]);
  });

  it("adds the e164, national and domestic forms of a phone value", async () => {
    const { loaded } = await load();

    const phone = (await loaded()).values.filter((entry) => entry.kind === "fixture alice.phone");
    expect(phone.map((entry) => entry.value)).toEqual(["+447700900123", "7700900123", "07700900123"]);
  });

  it("lists a secret no provider holds as skipped and keeps the ones it read", async () => {
    const { loaded } = await load();

    const scan = await loaded();
    expect(scan.values).toContainEqual({ kind: "secret DEMO_PIN", value: PIN });
    expect(scan.skipped).toHaveLength(1);
    expect(scan.skipped[0]).toContain("DEMO_GONE");
    expect(scan.around).toBe(Date.parse("2026-11-07T10:15:00Z"));
  });

  it("reads credentials of the env only, through the strategy or as a passkey list", async () => {
    const { cache, loaded } = await load();
    await cache.save({ env: "demo", identity: "ops", surface: "web", strategy: "bearer" }, { token: "fake-bearer-1" });
    await cache.save({ env: "demo", identity: "alice", surface: "web", strategy: "passkey-virtual" }, [
      { privateKey: "fake-key-a" },
      { privateKey: "fake-key-b" },
    ]);
    await cache.save({ env: "demo", identity: "bob", surface: "api", strategy: "mystery" }, { token: "fake-other" });
    await cache.save({ env: "other", identity: "ops", surface: "web", strategy: "bearer" }, { token: "fake-bearer-2" });

    const scan = await loaded();

    const credentials = scan.values.filter((entry) => entry.kind.startsWith("credential "));
    expect(credentials).toEqual([
      { kind: "credential alice/web", value: "fake-key-a" },
      { kind: "credential alice/web", value: "fake-key-b" },
      { kind: "credential ops/web", value: "fake-bearer-1" },
    ]);
    expect(scan.skipped.filter((line) => line.includes("bob/api"))).toHaveLength(1);
  });
});
