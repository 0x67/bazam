import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { SecretMissing, type SecretProvider } from "./provider.ts";

const run = promisify(execFile);

/** Reads keys listed in `refs` (key to `op://` reference) with the 1Password CLI. */
export function onePasswordProvider(refs: Readonly<Record<string, string>>): SecretProvider {
  return {
    name: "1password",
    async load(key) {
      const ref = refs[key];
      if (ref === undefined) return undefined;
      try {
        const { stdout } = await run("op", ["read", ref]);
        // op prints one newline after the secret
        return stdout.replace(/\r?\n$/, "");
      } catch (error) {
        const { stderr, message } = error as { stderr?: string; message: string };
        throw new SecretMissing(key, `op read ${ref} failed: ${stderr?.trim() || message}`);
      }
    },
  };
}
