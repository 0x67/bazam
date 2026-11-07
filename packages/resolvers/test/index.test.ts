import { fileURLToPath } from "node:url";
import { PluginRegistry } from "@bazam/core/plugin";
import { ProjectConfig } from "@bazam/core/project";
import { describe, expect, it } from "vite-plus/test";
import resolvers from "../src/index.ts";

describe("resolvers plugin", () => {
  it("gives env chains the three resolvers by the names config uses", async () => {
    const config = ProjectConfig.parse({
      envs: {
        demo: {
          production: false,
          hosts: ["localhost"],
          challenges: {
            "otp-email": ["otp-mailpit", "otp-http-hook", "human"],
            "otp-sms": ["otp-http-hook"],
            totp: ["totp"],
          },
        },
      },
    });
    const registry = await PluginRegistry.load(config, fileURLToPath(new URL(".", import.meta.url)), [resolvers]);
    const demo = config.envs["demo"]!;
    const names = (kind: string) => registry.resolverChain(demo, kind).map((resolver) => resolver.name);
    expect(names("otp-email")).toEqual(["otp-mailpit", "otp-http-hook", "human"]);
    expect(names("otp-sms")).toEqual(["otp-http-hook"]);
    expect(names("totp")).toEqual(["totp"]);
  });
});
