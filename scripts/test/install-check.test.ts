import { describe, expect, it } from "vite-plus/test";
import { InstallCheckFailed, installRecipes, type Tarball } from "../install-check.ts";

const tarballs: Tarball[] = [
  { file: "bazam-0.5.0.tgz", name: "bazam", version: "0.5.0" },
  { file: "bazam-core-0.5.0.tgz", name: "@bazam/core", version: "0.5.0" },
  { file: "bazam-driver-web-0.5.0.tgz", name: "@bazam/driver-web", version: "0.5.0" },
  { file: "bazam-mcp-0.5.0.tgz", name: "@bazam/mcp", version: "0.5.0" },
  { file: "bazam-resolvers-0.5.0.tgz", name: "@bazam/resolvers", version: "0.5.0" },
  { file: "bazam-tracker-jira-0.5.0.tgz", name: "@bazam/tracker-jira", version: "0.5.0" },
];

describe("installRecipes", () => {
  it("makes an empty private package for npm", () => {
    expect(JSON.parse(installRecipes(tarballs).npm.packageJson)).toEqual({ private: true });
  });

  it("lists every tarball as a vendored file dependency for pnpm", () => {
    expect(JSON.parse(installRecipes(tarballs).pnpm.packageJson)).toEqual({
      private: true,
      dependencies: {
        bazam: "file:vendor/bazam/bazam-0.5.0.tgz",
        "@bazam/core": "file:vendor/bazam/bazam-core-0.5.0.tgz",
        "@bazam/driver-web": "file:vendor/bazam/bazam-driver-web-0.5.0.tgz",
        "@bazam/mcp": "file:vendor/bazam/bazam-mcp-0.5.0.tgz",
        "@bazam/resolvers": "file:vendor/bazam/bazam-resolvers-0.5.0.tgz",
        "@bazam/tracker-jira": "file:vendor/bazam/bazam-tracker-jira-0.5.0.tgz",
      },
    });
  });

  it("overrides the five scoped names to the same paths, not the CLI", () => {
    const { workspaceYaml } = installRecipes(tarballs).pnpm;

    expect(workspaceYaml).toBe(
      [
        "overrides:",
        '  "@bazam/core": file:vendor/bazam/bazam-core-0.5.0.tgz',
        '  "@bazam/driver-web": file:vendor/bazam/bazam-driver-web-0.5.0.tgz',
        '  "@bazam/mcp": file:vendor/bazam/bazam-mcp-0.5.0.tgz',
        '  "@bazam/resolvers": file:vendor/bazam/bazam-resolvers-0.5.0.tgz',
        '  "@bazam/tracker-jira": file:vendor/bazam/bazam-tracker-jira-0.5.0.tgz',
        "",
      ].join("\n"),
    );
  });

  it("names the missing package", () => {
    const missing = tarballs.filter(({ name }) => name !== "@bazam/mcp");

    expect(() => installRecipes(missing)).toThrow(new InstallCheckFailed("no tarball for @bazam/mcp"));
  });
});
