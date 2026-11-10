import { join } from "node:path";
import { CredentialCache, type JsonValue } from "../auth/index.ts";
import { BRAND } from "../brand.ts";
import { phoneForm, type Environment } from "../env/index.ts";
import type { PluginRegistry } from "../plugin/index.ts";
import { declaredSecretNames, readLocalFixtures, type Project } from "../project.ts";
import type { Redactor } from "../redact/index.ts";
import { resolveSecret } from "../secrets/index.ts";
import type { FindingKind, ScanValues } from "./evidence-scan.ts";

// the web driver keeps passkeys in the credential cache under its resolver's name and registers their private keys
// (see packages/driver-web/src/passkey.ts::virtualPasskeyResolver)
const PASSKEY_RESOLVER = "passkey-virtual";

export interface ScanValuesDeps {
  project: Project;
  registry: PluginRegistry;
  env: Environment;
  redactor: Redactor;
  around: Date;
}

/** The fixture, secret and credential values an env's evidence must not hold. */
export async function loadScanValues(deps: ScanValuesDeps): Promise<ScanValues> {
  const values: { kind: FindingKind; value: string }[] = [];
  const skipped: string[] = [];
  values.push(...(await fixtureValues(deps.project)));
  values.push(...(await secretValues(deps, skipped)));
  values.push(...(await credentialValues(deps, skipped)));
  return { values, skipped, around: deps.around.getTime() };
}

async function fixtureValues(project: Project): Promise<{ kind: FindingKind; value: string }[]> {
  const shown = new Set(project.config.redaction.shown);
  const values: { kind: FindingKind; value: string }[] = [];
  for (const [entry, fields] of Object.entries((await readLocalFixtures(project.root)) ?? {})) {
    for (const [field, value] of Object.entries(fields)) {
      if (shown.has(field)) continue;
      const kind: FindingKind = `fixture ${entry}.${field}`;
      const forms = new Set([value]);
      // a field that holds a phone number is also written in its national and domestic forms
      if (phoneForm(value, "e164", "en") !== undefined) {
        for (const form of ["e164", "national", "domestic"] as const) forms.add(phoneForm(value, form, "en") ?? value);
      }
      for (const form of forms) values.push({ kind, value: form });
    }
  }
  return values;
}

async function secretValues(
  { project, registry, redactor }: ScanValuesDeps,
  skipped: string[],
): Promise<{ kind: FindingKind; value: string }[]> {
  const providers = registry.secretProviders(project.config.secrets.providers);
  const values: { kind: FindingKind; value: string }[] = [];
  for (const name of declaredSecretNames(project.config)) {
    try {
      values.push({ kind: `secret ${name}`, value: await resolveSecret(name, providers, redactor) });
    } catch (error) {
      skipped.push(`secret ${name} was not read: ${redactor.text((error as Error).message)}`);
    }
  }
  return values;
}

async function credentialValues(
  { project, registry, env }: ScanValuesDeps,
  skipped: string[],
): Promise<{ kind: FindingKind; value: string }[]> {
  const cache = new CredentialCache(join(project.root, BRAND.stateDir, "credentials"));
  const values: { kind: FindingKind; value: string }[] = [];
  for (const { key, credential } of await cache.list()) {
    if (key.env !== env.name) continue;
    const kind: FindingKind = `credential ${key.identity}/${key.surface}`;
    const secrets = credentialSecrets(registry, key.strategy, credential);
    if (secrets === undefined) skipped.push(`${kind} was not scanned: its secret values cannot be told`);
    else values.push(...secrets.map((value) => ({ kind, value })));
  }
  return values;
}

function credentialSecrets(registry: PluginRegistry, name: string, credential: JsonValue): string[] | undefined {
  try {
    const strategy = registry.strategy(name);
    if (strategy.cacheable) return strategy.secrets(credential);
  } catch {
    // not a strategy the registry holds, such as the passkey resolver
  }
  return name === PASSKEY_RESOLVER ? passkeyKeys(credential) : undefined;
}

function passkeyKeys(credential: JsonValue): string[] | undefined {
  if (!Array.isArray(credential)) return undefined;
  const keys = credential.map((passkey) =>
    typeof passkey === "object" && passkey !== null && !Array.isArray(passkey) ? passkey["privateKey"] : undefined,
  );
  return keys.every((key) => typeof key === "string") ? keys : undefined;
}
