import { fileURLToPath } from "node:url";
import { HumanOnlyViolation } from "@bazam/core/challenge";
import { PluginRegistry } from "@bazam/core/plugin";
import { ProjectConfig } from "@bazam/core/project";
import { describe, expect, it } from "vite-plus/test";
import resolvers from "../src/index.ts";
import { pinSecretDeclared } from "../src/pin-secret.ts";

const root = fileURLToPath(new URL(".", import.meta.url));

describe("resolvers plugin", () => {
  it("refuses pin-secret in the chain of pin when config lists pin as human-only", async () => {
    const config = ProjectConfig.parse({
      envs: { live: { production: true, hosts: ["app.example.test"], challenges: { pin: ["pin-secret"] } } },
      challenges: { humanOnly: ["pin"] },
    });
    const registry = await PluginRegistry.load(config, root, [resolvers]);

    expect(() => registry.resolverChain(config.envs["live"]!, "pin")).toThrow(HumanOnlyViolation);
  });

  it("adds the check rule for the secret pin-secret reads", async () => {
    const registry = await PluginRegistry.load(ProjectConfig.parse({ envs: {} }), root, [resolvers]);

    expect(registry.checkRules()).toContain(pinSecretDeclared);
  });

  it("gives env chains the four resolvers by the names config uses", async () => {
    const config = ProjectConfig.parse({
      envs: {
        demo: {
          production: false,
          hosts: ["localhost"],
          challenges: {
            "otp-email": ["otp-mailpit", "otp-http-hook", "human"],
            "otp-sms": ["otp-http-hook"],
            totp: ["totp"],
            pin: ["pin-secret"],
          },
        },
      },
    });
    const registry = await PluginRegistry.load(config, root, [resolvers]);
    const demo = config.envs["demo"]!;
    const names = (kind: string) => registry.resolverChain(demo, kind).map((resolver) => resolver.name);
    expect(names("otp-email")).toEqual(["otp-mailpit", "otp-http-hook", "human"]);
    expect(names("otp-sms")).toEqual(["otp-http-hook"]);
    expect(names("totp")).toEqual(["totp"]);
    expect(names("pin")).toEqual(["pin-secret"]);
  });
});
