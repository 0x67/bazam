import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { CredentialCache, Identities, type CredentialKey, type JsonValue } from "@bazam/core/auth";
import { BRAND } from "@bazam/core/brand";
import type { HumanChannel } from "@bazam/core/challenge";
import { resolvePlaceholders, RunValues, type Environment, type PlaceholderSources } from "@bazam/core/env";
import type { PluginRegistry } from "@bazam/core/plugin";
import { IdentityFixtures, readLocalFixtures, type ProjectConfig } from "@bazam/core/project";
import { newRunId } from "@bazam/core/result";
import { resolveSecret } from "@bazam/core/secrets";
import { CommandError, ExitCode } from "../exit.ts";
import type { CommandContext } from "../main.ts";
import { runDirOf } from "./plan.ts";

const DEFAULT_KEEPALIVE_MS = 2 * 60_000;
const DEFAULT_CHANNEL = "terminal";

export interface KeepaliveDeps {
  identities: Pick<Identities, "credentialState" | "ensureCredential" | "recoverFromUnauthorized">;
  /** False once the credential is gone from the cache, as after a logout. */
  isCached(): Promise<boolean>;
  /** Time between refreshes: the strategy's keepaliveMs, else two minutes. */
  intervalMs: number;
  log(line: string): void;
}

/** Thrown when keepalive finds the credential gone from the cache, on a check or on a save, so a logout stays done. */
class LoggedOut extends Error {}

/**
 * Saves only over an entry that is still there. Identities saves under the refresh lock and logout deletes
 * under it, so a credential logout deleted while a refresh waited for the lock is not saved back.
 */
class KeptAliveCache extends CredentialCache {
  override async save(key: CredentialKey, credential: JsonValue, expiresAt?: Date): Promise<void> {
    if ((await this.load(key)) === undefined) throw new LoggedOut();
    await super.save(key, credential, expiresAt);
  }
}

/**
 * Refreshes the identity's cached credential for the surface right away and then every `intervalMs`, under the
 * refresh lock runs take, until `signal` aborts or a logout deletes the credential. Needs a credential a run
 * cached; it never logs in.
 */
export async function keepalive(
  identity: string,
  surface: string,
  deps: KeepaliveDeps,
  signal: AbortSignal,
): Promise<void> {
  const { identities } = deps;
  const state = await identities.credentialState(identity, surface);
  if (state !== "cached" && state !== "refresh") {
    throw new CommandError(
      `no cached ${surface} credential for ${identity} to keep alive; run a case that logs in as ${identity} first`,
    );
  }
  try {
    await identities.ensureCredential(identity, surface);
    while (!signal.aborted) {
      // a revoked credential would fail its refresh; KeptAliveCache covers a logout during the refresh
      if (!(await deps.isCached())) throw new LoggedOut();
      // after a 401 the client calls this too: it refreshes under the lock, or takes what another process saved
      const refreshed = await identities.recoverFromUnauthorized(identity, surface).catch(async (error: unknown) => {
        // a logout between the check above and this refresh revokes the credential, so the refresh fails
        if (!(await deps.isCached())) throw new LoggedOut();
        throw error;
      });
      if (!refreshed) {
        if (!(await deps.isCached())) throw new LoggedOut();
        throw new CommandError(
          `the ${surface} credential of ${identity} cannot refresh; for session-cookie, add a refresh request to identities.${identity}.auth.${surface}.with in ${BRAND.configFile}; oauth2 needs a token with a refresh token, or the client-credentials grant`,
        );
      }
      deps.log(`refreshed ${identity}/${surface}`);
      try {
        await sleep(deps.intervalMs, undefined, { signal });
      } catch (error) {
        if (!signal.aborted) throw error;
      }
    }
  } catch (error) {
    if (!(error instanceof LoggedOut)) throw error;
    deps.log(`${identity}/${surface} was logged out; stopped keeping it alive`);
  }
}

/**
 * Keeps every surface of `--as` that caches its credential alive until Ctrl-C. A surface that cannot be kept
 * alive is logged and the others go on; exits 2 when none can be.
 */
export async function keepaliveCommand(ctx: CommandContext): Promise<number> {
  const { config, registry } = await ctx.loadPlugins();
  const env = envOf(config, ctx.flags.env);
  const identity = oneIdentity(ctx.flags.as);
  if (identity === undefined) throw new CommandError(`--as is required; identities: ${known(config.identities)}`);
  const auth = config.identities[identity]?.auth;
  if (auth === undefined)
    throw new CommandError(`unknown identity "${identity}"; identities: ${known(config.identities)}`);
  const surfaces = Object.entries(auth)
    // a from: surface shares the credential of the surface it names
    .filter(([, settings]) => !("from" in settings) && registry.strategy(settings.strategy).cacheable)
    .map(([surface, settings]) => ({ surface, strategy: registry.strategy(settings.strategy) }));
  if (surfaces.length === 0) {
    throw new CommandError(`identity ${identity} has no surface whose strategy caches a credential to keep alive`);
  }
  const scope = await credentialScope(ctx, config, registry, env);
  const { cacheDir, lockDir } = credentialDirs(ctx.root);
  const cache = new KeptAliveCache(cacheDir);
  const identities = new Identities({
    env,
    configs: config.identities,
    fixtures: scope.fixtures,
    registry,
    cache,
    lockDir,
    resolve: scope.resolve,
    redactor: ctx.redactor,
    log: scope.log,
    projectRoot: ctx.root,
    channel: scope.channel,
    now: () => new Date(),
  });
  const ended = await Promise.allSettled(
    surfaces.map(async ({ surface, strategy }) => {
      const key: CredentialKey = { env: env.name, identity, surface, strategy: strategy.name };
      const deps: KeepaliveDeps = {
        identities,
        isCached: async () => (await cache.load(key)) !== undefined,
        intervalMs: strategy.keepaliveMs ?? DEFAULT_KEEPALIVE_MS,
        log: scope.log,
      };
      try {
        await keepalive(identity, surface, deps, ctx.io.signal);
      } catch (error) {
        // the identity's other surfaces go on without this one
        if (surfaces.length > 1) {
          scope.log(
            `stopped keeping ${identity}/${surface} alive: ${error instanceof Error ? error.message : String(error)}`,
          );
        }
        throw error;
      }
    }),
  );
  const failures = ended.flatMap((outcome) => (outcome.status === "rejected" ? [outcome.reason as unknown] : []));
  if (failures.length === surfaces.length) {
    // with several surfaces, each reason was logged when its surface stopped
    throw surfaces.length === 1 ? failures[0] : new CommandError(`no surface of ${identity} could be kept alive`);
  }
  const names = surfaces.filter((_, index) => ended[index]?.status === "fulfilled").map(({ surface }) => surface);
  ctx.out.result(
    { env: env.name, identity, surfaces: names },
    `stopped keeping ${identity} alive on ${names.join(", ")} in env ${env.name}\n`,
  );
  return ExitCode.Pass;
}

/** Where runs cache credentials, and the refresh locks they share, under `<stateDir>`. */
export function credentialDirs(root: string): { cacheDir: string; lockDir: string } {
  const stateDir = join(root, BRAND.stateDir);
  return { cacheDir: join(stateDir, "credentials"), lockDir: join(stateDir, "locks") };
}

/** What renewing or revoking an env's cached credentials needs, built the way a run builds it. */
export interface CredentialScope {
  /** From the local fixtures file; empty when there is none. */
  fixtures: IdentityFixtures;
  /** Fills placeholders as a run's logins do, from no case. */
  resolve: <T>(value: T) => Promise<T>;
  /** The --channel, for a strategy that asks a person. */
  channel: HumanChannel;
  /** To stderr through the redactor. */
  log: (line: string) => void;
}

export async function credentialScope(
  ctx: CommandContext,
  config: ProjectConfig,
  registry: PluginRegistry,
  env: Environment,
): Promise<CredentialScope> {
  const fixtures = await localFixtures(ctx.root);
  const providers = registry.secretProviders(config.secrets.providers);
  const startedAt = new Date();
  const runId = newRunId(startedAt, Math.random);
  // the seed only matters to a ${run.random(...)} in auth settings, which has nothing to replay here
  const runValues = new RunValues(runId, startedAt, 0).forCase("");
  const sources: PlaceholderSources = {
    env: (key) => env.vars[key],
    secret: (key) => resolveSecret(key, providers, ctx.redactor),
    identity: (name, field) => {
      const fixture = config.identities[name]?.fixture;
      return fixture === undefined ? undefined : fixtures[fixture]?.[field];
    },
    run: (expression) => runValues.value(expression),
    case: () => undefined,
    locale: env.locale,
  };
  return {
    fixtures,
    resolve: (value) => resolvePlaceholders(value, sources),
    channel: registry.channel(ctx.flags.channel ?? DEFAULT_CHANNEL)(runDirOf(ctx.root, runId)),
    log: (line) => ctx.out.log(line),
  };
}

/** The env --env names; refuses a missing or unknown one. */
export function envOf(config: ProjectConfig, name: string | undefined): Environment {
  if (name === undefined) throw new CommandError(`--env is required; envs: ${known(config.envs)}`);
  const env = config.envs[name];
  if (env === undefined) throw new CommandError(`unknown env "${name}"; envs: ${known(config.envs)}`);
  return env;
}

/** The one identity `--as` names, if any; keepalive and logout act on a single identity. */
export function oneIdentity(values: readonly string[] | undefined): string | undefined {
  if (values !== undefined && values.length > 1) throw new CommandError("--as takes one identity here");
  return values?.[0];
}

export function known(names: Readonly<Record<string, unknown>>): string {
  return Object.keys(names).join(", ") || "none";
}

async function localFixtures(root: string): Promise<IdentityFixtures> {
  try {
    return (await readLocalFixtures(root)) ?? {};
  } catch (error) {
    throw new CommandError((error as Error).message);
  }
}
