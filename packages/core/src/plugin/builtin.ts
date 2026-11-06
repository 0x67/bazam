import { join } from "node:path";
import { BRAND } from "../brand.ts";
import { dotenvProvider, envProvider, onePasswordProvider } from "../secrets/index.ts";
import type { PluginManifest } from "./registry.ts";

/** The parts of the project config that the built-in contributions read. */
export interface BuiltinConfig {
  secrets?: { refs?: Readonly<Record<string, string>> };
}

// What core contributes as a plugin. The registry adds the name and API version, so this module
// imports only types from registry.ts and the two never form a run-time import cycle.
export function builtinContributions(config: BuiltinConfig, projectRoot: string): Omit<PluginManifest, "name" | "apiVersion"> {
  return {
    secretProviders: [envProvider, dotenvProvider(join(projectRoot, BRAND.stateDir)), onePasswordProvider(config.secrets?.refs ?? {})],
  };
}
