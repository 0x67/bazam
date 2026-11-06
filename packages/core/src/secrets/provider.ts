import type { Redactor } from "../redact/index.ts";

export interface SecretProvider {
  name: string;
  load(key: string): Promise<string | undefined>;
}

export class SecretMissing extends Error {
  readonly key: string;

  constructor(key: string, reason: string) {
    super(`secret ${key}: ${reason}`);
    this.name = "SecretMissing";
    this.key = key;
  }
}

// A run has one redactor, so a cached value is always registered with the redactor it goes back to.
const resolvedByRun = new WeakMap<Redactor, Map<string, string>>();

/** The first provider that returns a non-empty value wins. */
export async function resolveSecret(key: string, providers: readonly SecretProvider[], redactor: Redactor): Promise<string> {
  let resolved = resolvedByRun.get(redactor);
  if (resolved === undefined) {
    resolved = new Map();
    resolvedByRun.set(redactor, resolved);
  }
  const cached = resolved.get(key);
  if (cached !== undefined) return cached;

  for (const provider of providers) {
    const value = await provider.load(key);
    if (!value) continue;
    redactor.register(value);
    resolved.set(key, value);
    return value;
  }
  throw new SecretMissing(key, `no value from providers [${providers.map((provider) => provider.name).join(", ")}]`);
}
