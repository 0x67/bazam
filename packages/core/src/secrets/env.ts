import type { SecretProvider } from "./provider.ts";

/** Reads the environment variable named exactly like the key. */
export const envProvider: SecretProvider = {
  name: "env",
  async load(key) {
    return process.env[key];
  },
};
