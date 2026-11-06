import { describe, expect, it } from "vitest";
import { z } from "zod";
import { buildCaseSchema } from "../src/case/index.ts";
import { PLUGIN_API_VERSION, PluginRegistry, type PluginManifest } from "../src/plugin/index.ts";
import { ProjectConfig } from "../src/project.ts";
import { fakeDriver } from "./support/fake-driver.ts";

const web = fakeDriver({ target: "web", capabilities: ["browser.login", "webauthn.virtual"] });
const mobile = fakeDriver({
  target: "mobile",
  capabilities: ["camera.inject"],
  steps: [{ kind: "swipe", schema: z.strictObject({ direction: z.enum(["left", "right"]) }), run: async () => {} }],
});
const drivers: PluginManifest = { name: "devices", apiVersion: PLUGIN_API_VERSION, drivers: [web, mobile] };

async function loadDrivers(): Promise<PluginRegistry> {
  return PluginRegistry.load(ProjectConfig.parse({ envs: {} }), process.cwd(), [drivers]);
}

describe("driver contract", () => {
  it("driver() returns the driver registered for the target", async () => {
    const registry = await loadDrivers();

    expect(registry.driver("mobile")).toBe(mobile);
    expect(registry.driver("web")).toBe(web);
  });

  it("driver() names the known targets when no driver serves the target", async () => {
    const registry = await loadDrivers();

    expect(() => registry.driver("desktop")).toThrow('unknown driver target "desktop"; known: web, mobile');
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

    expect(schema.safeParse(withStep({ swipe: { direction: "left" }, as: "customer" })).success).toBe(true);
    expect(schema.safeParse(withStep({ swipe: { direction: "up" } })).success).toBe(false);
  });
});
