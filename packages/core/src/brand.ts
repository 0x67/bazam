// The one place package source writes the product name, apart from import specifiers; pnpm brand:check
// enforces that, and scripts/rename.ts rewrites the name across the repository.
export const BRAND = {
  name: "bazam",
  scope: "@bazam",
  configFile: "bazam.config.yaml",
  stateDir: ".bazam",
  envPrefix: "BAZAM_",
  markerPrefix: "bazam",
  skillName: "bazam-author",
  mcpServerName: "bazam",
} as const;
