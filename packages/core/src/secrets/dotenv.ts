import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { parseEnv } from "node:util";
import type { SecretProvider } from "./provider.ts";

/** Reads `<stateDir>/secrets.env`; a missing file holds no values. */
export function dotenvProvider(stateDir: string): SecretProvider {
  const file = join(stateDir, "secrets.env");
  return {
    name: "dotenv",
    async load(key) {
      let content: string;
      try {
        content = await readFile(file, "utf8");
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
        throw error;
      }
      return parseEnv(content)[key];
    },
  };
}
