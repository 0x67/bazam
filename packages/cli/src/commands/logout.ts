import { readdir } from "node:fs/promises";
import {
  CredentialCache,
  withRefreshLock,
  type AuthContext,
  type AuthStrategy,
  type CredentialKey,
  type JsonValue,
} from "@bazam/core/auth";
import { guardedHttp } from "@bazam/core/driver";
import type { Environment } from "@bazam/core/env";
import type { PluginRegistry } from "@bazam/core/plugin";
import { CommandError, ExitCode } from "../exit.ts";
import type { CommandContext } from "../main.ts";
import {
  credentialDirs,
  credentialScope,
  envOf,
  known,
  oneIdentity,
  type CredentialScope,
} from "./keepalive.ts";

interface LoggedOut {
  env: string;
  identity: string;
  surface: string;
  strategy: string;
  /** True when the strategy revoked the credential at the server. */
  revoked: boolean;
  /** Why revoke failed; the cached credential is deleted all the same. */
  error?: string;
  /**
   * The config no longer has its env, identity or surface, or that surface now logs in with another strategy or
   * reuses another surface's credential with `from:`, so it was deleted without a revoke.
   */
  stale?: true;
}

/** A cached credential, with the strategy that cached it. */
interface Entry {
  key: CredentialKey;
  strategy: AuthStrategy<unknown, JsonValue>;
}

/**
 * Deletes the cached credentials of `--as` (every identity without it) in `--env` (every env without it),
 * after asking the strategy to revoke each where it can. Exits 1 when a revoke failed.
 */
export async function logoutCommand(ctx: CommandContext): Promise<number> {
  const { config, registry } = await ctx.loadPlugins();
  const { cacheDir, lockDir } = credentialDirs(ctx.root);
  const { env: envName } = ctx.flags;
  const identityName = oneIdentity(ctx.flags.as);
  // read from the folder, so it also finds what an older config cached under names it no longer has
  const entries = (await cachedEntries(cacheDir, registry)).filter(
    ({ key }) =>
      (envName ?? key.env) === key.env && (identityName ?? key.identity) === key.identity,
  );
  if (entries.length === 0) {
    // a name that neither the config nor the cache knows is most likely a typo
    if (envName !== undefined) envOf(config, envName);
    if (identityName !== undefined && config.identities[identityName] === undefined)
      throw new CommandError(
        `unknown identity "${identityName}"; identities: ${known(config.identities)}`,
      );
  }
  const cache = new CredentialCache(cacheDir);
  const scopes = new Map<string, CredentialScope>();
  const done: LoggedOut[] = [];
  for (const entry of entries) {
    const { key } = entry;
    const env = config.envs[key.env];
    const identity = config.identities[key.identity];
    const settings = identity?.auth[key.surface];
    let slot: Slot | undefined;
    // a revoke needs the settings the credential was made with
    if (
      env !== undefined &&
      settings !== undefined &&
      !("from" in settings) &&
      settings.strategy === key.strategy
    ) {
      const scope = scopes.get(env.name) ?? (await credentialScope(ctx, config, registry, env));
      scopes.set(env.name, scope);
      const fields =
        identity?.fixture === undefined ? {} : (scope.fixtures[identity.fixture] ?? {});
      slot = { env, identity: key.identity, scope, settings: settings.with, fields };
    }
    // held so a refresh in another process cannot save over the credential while it is revoked and deleted
    const outcome = await withRefreshLock(lockDir, key, () => logOut(ctx, cache, entry, slot));
    if (outcome !== undefined) done.push(outcome);
  }
  ctx.out.result({ loggedOut: done }, logoutText(done));
  return done.some((outcome) => outcome.error !== undefined) ? ExitCode.Fail : ExitCode.Pass;
}

/**
 * Every cached login credential, read back from the file names CredentialCache gives them:
 * `<env>+<identity>+<surface>+<strategy>.json`, each part URI-encoded. A file under a name that no auth
 * strategy caches with, such as the passkeys the web driver keeps there, is not one.
 */
async function cachedEntries(dir: string, registry: PluginRegistry): Promise<Entry[]> {
  let files: string[];
  try {
    files = await readdir(dir);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  return files.toSorted().flatMap((file) => {
    // a save in progress leaves a .tmp file
    const parts = file.endsWith(".json") ? file.slice(0, -".json".length).split("+") : [];
    if (parts.length !== 4) return [];
    const [env, identity, surface, strategy] = parts.map(decodeURIComponent) as [
      string,
      string,
      string,
      string,
    ];
    const cached = cachingStrategy(registry, strategy);
    return cached === undefined
      ? []
      : [{ key: { env, identity, surface, strategy }, strategy: cached }];
  });
}

function cachingStrategy(
  registry: PluginRegistry,
  name: string,
): AuthStrategy<unknown, JsonValue> | undefined {
  let strategy: AuthStrategy<unknown, JsonValue>;
  try {
    strategy = registry.strategy(name);
  } catch {
    return undefined;
  }
  return strategy.cacheable ? strategy : undefined;
}

/** What revoking a credential needs, from the config entry that names it. */
interface Slot {
  env: Environment;
  identity: string;
  scope: CredentialScope;
  /** The surface's `with:` settings, placeholders unresolved. */
  settings: Record<string, unknown>;
  /** The identity's fields from the local fixtures file. */
  fields: Readonly<Record<string, string>>;
}

/** Undefined when nothing was cached. Without a slot it deletes the credential and revokes nothing. */
async function logOut(
  ctx: CommandContext,
  cache: CredentialCache,
  { key, strategy }: Entry,
  slot: Slot | undefined,
): Promise<LoggedOut | undefined> {
  const cached = await cache.load(key);
  if (cached === undefined) return undefined;
  for (const value of strategy.secrets(cached.credential)) ctx.redactor.register(value);
  const outcome: LoggedOut = { ...key, revoked: false };
  if (slot === undefined) {
    outcome.stale = true;
  } else if (strategy.revoke !== undefined) {
    try {
      const parsed = strategy.config.safeParse(await slot.scope.resolve(slot.settings));
      if (!parsed.success)
        throw new Error(`${key.identity}/${key.surface} has invalid ${strategy.name} settings`);
      await strategy.revoke(cached.credential, parsed.data, authContext(ctx, slot));
      outcome.revoked = true;
    } catch (error) {
      outcome.error = error instanceof Error ? error.message : String(error);
    }
  }
  await cache.delete(key);
  return outcome;
}

/** The context Identities gives a strategy: an HTTP client that sends no credential of its own. */
function authContext(ctx: CommandContext, slot: Slot): AuthContext {
  return {
    identity: slot.identity,
    fields: slot.fields,
    env: slot.env,
    http: guardedHttp({ env: slot.env, redactor: ctx.redactor, log: slot.scope.log }),
    projectRoot: ctx.root,
    person: slot.scope.channel,
    now: () => new Date(),
  };
}

function logoutText(done: readonly LoggedOut[]): string {
  if (done.length === 0) return "no cached credential to delete\n";
  const lines = done.map(({ env, identity, surface, strategy, revoked, error, stale }) => {
    if (stale === true)
      return `logged out ${identity}/${surface} (${strategy}) in env ${env}, left by an older config`;
    const how = error !== undefined ? `; revoke failed: ${error}` : revoked ? ", revoked" : "";
    return `logged out ${identity}/${surface} in env ${env}${how}`;
  });
  return `${lines.join("\n")}\n`;
}
