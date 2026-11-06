import { join } from "node:path";
import { BRAND } from "../brand.ts";
import { answersFileChannel, builtinKinds, humanResolver, terminalChannel } from "../challenge/index.ts";
import { builtinRules } from "../check/index.ts";
import { httpSteps } from "../driver/http.ts";
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
    steps: [...httpSteps],
    resolvers: [humanResolver],
    challengeKinds: [...builtinKinds],
    secretProviders: [envProvider, dotenvProvider(join(projectRoot, BRAND.stateDir)), onePasswordProvider(config.secrets?.refs ?? {})],
    channels: [
      // stdout carries only a command's result, such as the one JSON document of --json
      { name: "terminal", create: () => terminalChannel({ input: process.stdin, output: process.stderr }) },
      { name: "answers-file", create: (runDir) => answersFileChannel(runDir) },
    ],
    checkRules: [...builtinRules],
  };
}
