import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BRAND } from "../src/brand.ts";
import {
  definePlugin,
  PLUGIN_API_VERSION,
  PluginApiMismatch,
  PluginConflict,
  PluginRegistry,
  type PluginManifest,
} from "../src/plugin/index.ts";
import type { SecretProvider } from "../src/secrets/index.ts";
import { fakeDriver, fakeStep } from "./support/fake-driver.ts";

const projectRoot = fileURLToPath(new URL("./fixtures/plugins", import.meta.url));

function plugin(name: string, contributions: Omit<PluginManifest, "name" | "apiVersion"> = {}): PluginManifest {
  return definePlugin({ name, apiVersion: PLUGIN_API_VERSION, ...contributions });
}

async function loadFailure(defaults: readonly PluginManifest[], plugins: readonly string[] = []): Promise<unknown> {
  return PluginRegistry.load({ plugins }, projectRoot, defaults).then(
    () => undefined,
    (error: unknown) => error,
  );
}

async function stepKinds(plugins: readonly string[]): Promise<string[]> {
  const registry = await PluginRegistry.load({ plugins }, projectRoot, []);
  return registry.stepHandlers().map((step) => step.kind);
}

function secretProvider(name: string): SecretProvider {
  return { name, load: async () => undefined };
}

describe("PluginRegistry.load", () => {
  it("PluginConflict names both plugins", async () => {
    const failure = await loadFailure([plugin("mail", { steps: [fakeStep("wait")] }), plugin("sms", { steps: [fakeStep("wait")] })]);

    expect(failure).toBeInstanceOf(PluginConflict);
    expect((failure as PluginConflict).plugins).toEqual(["mail", "sms"]);
    expect((failure as PluginConflict).message).toBe('step kind "wait" comes from both plugin "mail" and plugin "sms"');
  });

  it.each([
    ["two drivers for one target", { drivers: [fakeDriver({ target: "web" })] }, { drivers: [fakeDriver({ target: "web" })] }, 'driver target "web"'],
    [
      "a driver step with the kind of a plugin step",
      { steps: [fakeStep("tap")] },
      { drivers: [fakeDriver({ steps: [fakeStep("tap")] })] },
      'step kind "tap"',
    ],
  ])("PluginConflict also covers %s", async (_, first, second, contribution) => {
    const failure = await loadFailure([plugin("first", first), plugin("second", second)]);

    expect(failure).toBeInstanceOf(PluginConflict);
    expect((failure as PluginConflict).message).toBe(`${contribution} comes from both plugin "first" and plugin "second"`);
  });

  it("PluginApiMismatch on another major", async () => {
    const failure = await loadFailure([{ name: "old-driver", apiVersion: PLUGIN_API_VERSION + 1 }]);

    expect(failure).toBeInstanceOf(PluginApiMismatch);
    expect((failure as PluginApiMismatch).message).toContain(`plugin "old-driver" needs plugin API version ${PLUGIN_API_VERSION + 1}`);
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

    expect((failure as Error).message).toContain(`plugin path "${entry}" is outside the project root`);
  });

  // from the fixture root the resolver reaches packages/core/node_modules, so ".." climbs into packages/core/test
  it.each([
    ["..", "no-such-package/../../test/support/fake-driver.ts"],
    ["backslash", "no-such-package\\..\\..\\test\\support\\fake-driver.ts"],
  ])("refuses a plugin package name with %s segments", async (_, entry) => {
    const failure = await loadFailure([], [entry]);

    expect((failure as Error).message).toBe(`plugin "${entry}" is neither a package name nor a path that starts with "."`);
  });

  it("lets drivers for different targets offer the same step kind", async () => {
    const web = fakeDriver({ target: "web", steps: [fakeStep("open")] });
    const webChrome = fakeDriver({ target: "web-chrome", steps: [fakeStep("open")] });
    const mobile = fakeDriver({ target: "mobile", steps: [fakeStep("open")] });

    const registry = await PluginRegistry.load({}, projectRoot, [
      plugin("web-drivers", { drivers: [web, webChrome] }),
      plugin("mobile-driver", { drivers: [mobile] }),
    ]);
    const open = registry.stepHandlers().filter((step) => step.kind === "open");

    expect(registry.driver("web-chrome")).toBe(webChrome);
    expect(open).toHaveLength(1);
    expect(open[0]).toBe(web.steps[0]);
  });

  it.each(["use", "request", "challenge", "guided", "note"])("refuses a plugin step of the core step kind %s", async (kind) => {
    const failure = await loadFailure([plugin("rogue", { steps: [fakeStep(kind)] })]);

    expect(failure).toBeInstanceOf(PluginConflict);
    expect((failure as PluginConflict).plugins).toEqual([`${BRAND.scope}/core`, "rogue"]);
  });

  it("refuses a driver step of a core step kind", async () => {
    const failure = await loadFailure([plugin("rogue", { drivers: [fakeDriver({ steps: [fakeStep("challenge")] })] })]);

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
    const registry = await PluginRegistry.load({}, root, []);

    expect(registry.secretProviders(["env", "dotenv", "1password"]).map((provider) => provider.name)).toEqual([
      "env",
      "dotenv",
      "1password",
    ]);
  });

  it("reads dotenv values from the project's state directory", async () => {
    await mkdir(join(root, BRAND.stateDir));
    await writeFile(join(root, BRAND.stateDir, "secrets.env"), "DEMO_TOTP_SEED=fake-seed-from-dotenv\n");
    const registry = await PluginRegistry.load({}, root, []);

    const [dotenv] = registry.secretProviders(["dotenv"]);

    expect(await dotenv?.load("DEMO_TOTP_SEED")).toBe("fake-seed-from-dotenv");
  });

  // execFile cannot run the sh stub on Windows
  it.skipIf(process.platform === "win32")("gives the 1password provider the refs from config", async () => {
    vi.stubEnv("PATH", fileURLToPath(new URL("./fixtures/bin", import.meta.url)));
    const registry = await PluginRegistry.load({ secrets: { refs: { PARTNER_HMAC_SECRET: "op://qa/partner/hmac" } } }, root, []);

    const [onePassword] = registry.secretProviders(["1password"]);

    expect(await onePassword?.load("PARTNER_HMAC_SECRET")).toBe("fake-hmac-secret-from-op");
  });
});

describe("PluginRegistry.secretProviders", () => {
  const defaults = [
    plugin("vault-plugin", { secretProviders: [secretProvider("vault")] }),
    plugin("cloud-plugin", { secretProviders: [secretProvider("aws"), secretProvider("gcp")] }),
  ];

  it("returns providers in the order of the names, not the order plugins registered them", async () => {
    const registry = await PluginRegistry.load({}, projectRoot, defaults);

    expect(registry.secretProviders(["gcp", "vault"]).map((provider) => provider.name)).toEqual(["gcp", "vault"]);
  });

  it("throws on an unknown provider name and lists the known ones", async () => {
    const registry = await PluginRegistry.load({}, projectRoot, defaults);

    expect(() => registry.secretProviders(["vault", "valt"])).toThrow(/^unknown secret provider "valt"; known: .*\bvault\b/);
  });
});
