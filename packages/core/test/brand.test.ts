import { expect, it } from "vitest";
import { BRAND } from "../src/brand.ts";

it("derives the config file, env prefix, state dir and MCP name from BRAND", () => {
  const { name } = BRAND;
  expect(BRAND).toEqual({
    name,
    scope: `@${name}`,
    configFile: `${name}.config.yaml`,
    stateDir: `.${name}`,
    envPrefix: `${name.toUpperCase().replaceAll("-", "_")}_`,
    markerPrefix: name,
    skillName: `${name}-author`,
    mcpServerName: name,
  });
});
