import { describe, expect, it } from "vite-plus/test";
import { z } from "zod";
import { buildCaseSchema } from "../src/case/index.ts";
import { PLUGIN_API_VERSION, PluginRegistry, type PluginManifest } from "../src/plugin/index.ts";
import { ProjectConfig } from "../src/project.ts";
import { fakeDriver } from "./support/fake-driver.ts";

const web = fakeDriver({ name: "playwright", capabilities: ["browser.login", "webauthn.virtual"] });
const mobile = fakeDriver({
  name: "appium",
  surface: "mobile",
  capabilities: ["camera.inject"],
  steps: [
    {
      kind: "swipe",
      schema: z.strictObject({ direction: z.enum(["left", "right"]) }),
      run: async () => {},
    },
  ],
});
const drivers: PluginManifest = {
  name: "devices",
  apiVersion: PLUGIN_API_VERSION,
  drivers: [web, mobile],
};

async function loadDrivers(): Promise<PluginRegistry> {
  return PluginRegistry.load(ProjectConfig.parse({ envs: {} }), process.cwd(), [drivers]);
}

describe("driver contract", () => {
  it("driver() returns the driver registered under the name", async () => {
    const registry = await loadDrivers();

    expect(registry.driver("appium")).toBe(mobile);
    expect(registry.driver("playwright")).toBe(web);
  });

  it("driver() names the known drivers when no driver has the name", async () => {
    const registry = await loadDrivers();

    expect(() => registry.driver("selenium")).toThrow(
      'unknown driver "selenium"; known: playwright, appium',
    );
  });

  it("a case schema built from stepHandlers() accepts a driver step and checks its payload", async () => {
    const schema = buildCaseSchema((await loadDrivers()).stepHandlers());
    const withStep = (step: unknown) => ({
      id: "APP-SWIPE-001",
      title: "Customer swipes the onboarding cards",
      stage: "draft",
      risk: "low",
      targets: ["mobile"],
      steps: [step],
    });

    expect(
      schema.safeParse(withStep({ swipe: { direction: "left" }, as: "customer" })).success,
    ).toBe(true);
    expect(schema.safeParse(withStep({ swipe: { direction: "up" } })).success).toBe(false);
  });

  it("a case schema built from stepHandlers() accepts the core api check as a step, under checks and in observe", async () => {
    const schema = buildCaseSchema((await loadDrivers()).stepHandlers());
    const check = {
      api: {
        request: "GET ${env.API_URL}/me",
        as: "customer",
        status: 200,
        body: { "roles[0]": "buyer" },
      },
    };
    const withChecks = (step: unknown) => ({
      id: "API-ME-001",
      title: "Customer reads their profile",
      stage: "draft",
      risk: "low",
      targets: ["web"],
      steps: [
        step,
        { guided: { title: "Open the profile", steps: ["Open the profile page"], observe: step } },
      ],
      checks: [step],
    });

    expect(schema.safeParse(withChecks(check)).success).toBe(true);
    expect(
      schema.safeParse(withChecks({ api: { request: "${env.API_URL}/me", status: 200 } })).success,
    ).toBe(false);
    expect(
      schema.safeParse(withChecks({ api: { request: "GET ${env.API_URL}/me" } })).success,
    ).toBe(false);
  });
});
