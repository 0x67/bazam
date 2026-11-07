import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { JsonValue } from "./strategy.ts";

export interface CredentialKey {
  env: string;
  identity: string;
  surface: string;
  strategy: string;
}

export interface CachedCredential {
  credential: JsonValue;
  /** ISO time. */
  expiresAt?: string;
}

/** One file per key, readable only by the owner. */
export class CredentialCache {
  readonly #dir: string;

  /** `dir` is `<stateDir>/credentials`. */
  constructor(dir: string) {
    this.#dir = dir;
  }

  async load(key: CredentialKey): Promise<CachedCredential | undefined> {
    let text: string;
    try {
      text = await readFile(this.#file(key), "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw error;
    }
    return JSON.parse(text) as CachedCredential;
  }

  /** Writes a temp file with mode 0600 and renames it over the old one, so a reader never sees half a file. */
  async save(key: CredentialKey, credential: JsonValue, expiresAt?: Date): Promise<void> {
    await mkdir(this.#dir, { recursive: true, mode: 0o700 });
    const file = this.#file(key);
    const temp = `${file}.${randomUUID()}.tmp`;
    const entry: CachedCredential =
      expiresAt === undefined ? { credential } : { credential, expiresAt: expiresAt.toISOString() };
    await writeFile(temp, JSON.stringify(entry), { mode: 0o600, flag: "wx" });
    try {
      await rename(temp, file);
    } catch (error) {
      await rm(temp, { force: true });
      throw error;
    }
  }

  async delete(key: CredentialKey): Promise<void> {
    await rm(this.#file(key), { force: true });
  }

  #file(key: CredentialKey): string {
    // encodeURIComponent escapes "+" and path separators, so the name is unambiguous and stays in the folder
    const stem = [key.env, key.identity, key.surface, key.strategy].map(encodeURIComponent).join("+");
    return join(this.#dir, `${stem}.json`);
  }
}
