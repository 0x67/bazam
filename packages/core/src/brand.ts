// The one place the product name is written; scripts/rename.ts rewrites it.
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
