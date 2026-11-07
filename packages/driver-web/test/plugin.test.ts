import { EnvsConfig } from "@bazam/core/env";
import { PluginRegistry } from "@bazam/core/plugin";
import { ProjectConfig } from "@bazam/core/project";
import { describe, expect, it } from "vitest";
import plugin, { playwrightDriver, virtualPasskeyResolver } from "../src/index.ts";

describe("driver-web plugin", () => {
  it("loads beside core as a default plugin with the playwright driver, its steps and the passkey resolver", async () => {
    const envs = { demo: { production: false, hosts: ["127.0.0.1"], challenges: { passkey: ["passkey-virtual"] } } };
    const registry = await PluginRegistry.load(ProjectConfig.parse({ envs }), "/project", [plugin]);

    expect(registry.driver("playwright")).toBe(playwrightDriver);
    expect(registry.resolverChain(EnvsConfig.parse(envs)["demo"]!, "passkey")).toEqual([virtualPasskeyResolver]);
    expect(registry.stepHandlers().map((step) => step.kind)).toEqual(
      expect.arrayContaining(["open", "tap", "fill", "press", "select", "expect", "screenshot", "wait"]),
    );
  });
});
