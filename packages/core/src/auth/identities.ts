import { z } from "zod";
import type { HumanChannel } from "../challenge/index.ts";
import { guardedHttp, type GuardedHttp } from "../driver/http.ts";
import type { Environment } from "../env/index.ts";
import type { Redactor } from "../redact/index.ts";
import type { BrowserLogin } from "./browser.ts";
import type { CredentialCache, CredentialKey } from "./cache.ts";
import { withRefreshLock } from "./lock.ts";
import type { ApplyTarget, AuthContext, AuthStrategy, JsonValue } from "./strategy.ts";

/** Where a credential will come from: the cache, a refresh, a scripted or person login, or static secrets. */
export type LoginMode = "cached" | "refresh" | "scripted" | "person" | "static";

const IdentityName = z.string().regex(/^[a-z][a-z0-9-]*$/, { error: 'an identity name looks like "customer" or "partner-admin"' });
const SurfaceName = z.string().regex(/^[a-z][a-z0-9-]*$/, { error: 'a surface name looks like "web" or "api"' });
const StrategyName = z.string().min(1);

const SurfaceAuth = z.union([
  // reuses the credential of another surface, such as the cookies a web login produced
  z.strictObject({ strategy: StrategyName, from: SurfaceName }),
  z.strictObject({ strategy: StrategyName, with: z.record(z.string(), z.unknown()).default({}) }),
]);

const IdentityConfig = z
  .strictObject({
    /** The entry in the identities fixtures file that holds this identity's fields. */
    fixture: z.string().min(1).optional(),
    auth: z.record(SurfaceName, SurfaceAuth).default({}),
  })
  .superRefine((identity, ctx) => {
    for (const [surface, auth] of Object.entries(identity.auth)) {
      if (!("from" in auth)) continue;
      const source = identity.auth[auth.from];
      const path = ["auth", surface, "from"];
      if (source === undefined || "from" in source) {
        ctx.addIssue({ code: "custom", path, message: `from: "${auth.from}" must name a surface of this identity with its own settings` });
      } else if (source.strategy !== auth.strategy) {
        ctx.addIssue({ code: "custom", path, message: `surface "${auth.from}" uses strategy ${source.strategy}, not ${auth.strategy}` });
      }
    }
  });

/** The `identities` mapping of the project config. */
export const IdentitiesConfig = z.record(IdentityName, IdentityConfig);
export type IdentitiesConfig = z.infer<typeof IdentitiesConfig>;

export interface IdentitiesDeps {
  env: Environment;
  configs: IdentitiesConfig;
  /** Fields by fixture entry name. */
  fixtures: Readonly<Record<string, Readonly<Record<string, string>>>>;
  /** Looks strategies up by name; PluginRegistry is the one runs pass. */
  registry: { strategy(name: string): AuthStrategy<unknown, JsonValue> };
  cache: CredentialCache;
  /** `<stateDir>/locks`. */
  lockDir: string;
  /** Fills the placeholders in a surface's `with:` settings. */
  resolve<T>(value: T): Promise<T>;
  redactor: Redactor;
  /** Gets one line per request a strategy sends through `AuthContext.http`. */
  log(line: string): void;
  /** Strategies get it as `AuthContext.projectRoot`. */
  projectRoot: string;
  /** Strategies get it as `AuthContext.person`. */
  channel: HumanChannel;
  /** Present when the driver offers browser.login. */
  browser?: BrowserLogin;
  now(): Date;
}

/** A credential that came back from a login or a refresh failed the strategy's probe. */
export class CredentialRejected extends Error {
  constructor(slot: string, strategy: string) {
    super(`the new ${strategy} credential for ${slot} failed its probe`);
    this.name = "CredentialRejected";
  }
}

interface Held {
  credential: JsonValue;
  expiresAt: Date | undefined;
}

/** The surface that owns a credential, after following `from:`. */
interface Slot {
  /** `<identity>/<surface>` */
  id: string;
  identity: string;
  key: CredentialKey;
  strategy: AuthStrategy<unknown, JsonValue>;
  settings: Record<string, unknown>;
}

/** The identities a run acts as, each with one credential per surface. */
export class Identities {
  readonly #deps: IdentitiesDeps;
  readonly #held = new Map<string, Held>();
  readonly #configs = new Map<string, Promise<unknown>>();
  // built without identities, so a strategy's own request can never ask for a credential
  readonly #http: GuardedHttp;

  constructor(deps: IdentitiesDeps) {
    this.#deps = deps;
    this.#http = guardedHttp({ env: deps.env, redactor: deps.redactor, log: deps.log });
  }

  /** Probes, refreshes, acquires and resolves nothing, so it fetches no secret; reads only the cache. */
  async credentialState(identity: string, surface: string): Promise<LoginMode> {
    const slot = this.#slot(identity, surface);
    if (!slot.strategy.cacheable) return "static";
    const held = this.#held.get(slot.id) ?? (await this.#loadCached(slot));
    if (held !== undefined && !this.#isExpired(held)) return "cached";
    if (held !== undefined && this.#refreshFor(slot, held.credential) !== undefined) return "refresh";
    return slot.strategy.needsPerson?.(slot.settings) === true ? "person" : "scripted";
  }

  /**
   * Leaves the identity with an unexpired credential for the surface that passed the probe. A cached one is
   * probed once per process; a stale one is refreshed or acquired under the refresh lock.
   */
  async ensureCredential(identity: string, surface: string): Promise<void> {
    await this.#ensure(this.#slot(identity, surface));
  }

  async authorize(identity: string, surface: string, target: ApplyTarget): Promise<void> {
    const slot = this.#slot(identity, surface);
    const held = await this.#ensure(slot);
    await slot.strategy.apply(held.credential, target, await this.#config(slot));
  }

  /**
   * For the HTTP client after a 401: refreshes once under the lock, or takes the credential another process
   * refreshed meanwhile. False when there is nothing to refresh, so the client gives up.
   */
  async recoverFromUnauthorized(identity: string, surface: string): Promise<boolean> {
    const slot = this.#slot(identity, surface);
    if (slot.strategy.refresh === undefined) return false;
    const used = this.#held.get(slot.id);
    const config = await this.#config(slot);
    return withRefreshLock(this.#deps.lockDir, slot.key, async () => {
      const reloaded = await this.#loadCached(slot);
      if (reloaded !== undefined && !isSameCredential(reloaded, used)) {
        this.#keep(slot, reloaded);
        return true;
      }
      const previous = reloaded ?? used;
      const refresh = previous === undefined ? undefined : this.#refreshFor(slot, previous.credential);
      if (previous === undefined || refresh === undefined) return false;
      await this.#adopt(slot, await refresh(previous.credential, config, this.#context(slot.identity)));
      return true;
    });
  }

  async #ensure(slot: Slot): Promise<Held> {
    const held = this.#held.get(slot.id);
    if (held !== undefined && !this.#isExpired(held)) return held;
    const config = await this.#config(slot);
    let stale = held;
    if (stale === undefined) {
      const cached = await this.#loadCached(slot);
      if (cached !== undefined && (await this.#isUsable(slot, config, cached))) return this.#keep(slot, cached);
      stale = cached;
    }
    if (!slot.strategy.cacheable) return this.#renew(slot, config, stale);
    return withRefreshLock(this.#deps.lockDir, slot.key, async () => {
      // another process may have refreshed it while this one waited for the lock
      const reloaded = await this.#loadCached(slot);
      if (reloaded !== undefined && !isSameCredential(reloaded, stale) && (await this.#isUsable(slot, config, reloaded))) {
        return this.#keep(slot, reloaded);
      }
      return this.#renew(slot, config, reloaded ?? stale);
    });
  }

  async #renew(slot: Slot, config: unknown, previous: Held | undefined): Promise<Held> {
    const credential = await this.#refreshOrAcquire(slot, config, previous);
    if (!(await this.#passesProbe(slot, config, credential))) throw new CredentialRejected(slot.id, slot.strategy.name);
    return this.#adopt(slot, credential);
  }

  async #refreshOrAcquire(slot: Slot, config: unknown, previous: Held | undefined): Promise<JsonValue> {
    const ctx = this.#context(slot.identity);
    const refresh = previous === undefined ? undefined : this.#refreshFor(slot, previous.credential);
    if (previous !== undefined && refresh !== undefined) {
      try {
        return await refresh(previous.credential, config, ctx);
      } catch {
        // a refresh token can expire or be revoked; logging in again replaces it
      }
    }
    return slot.strategy.acquire(config, ctx);
  }

  /** The strategy's refresh, unless it has none or says it cannot renew this credential. */
  #refreshFor(slot: Slot, credential: JsonValue): AuthStrategy<unknown, JsonValue>["refresh"] {
    if (slot.strategy.canRefresh?.(credential, slot.settings) === false) return undefined;
    return slot.strategy.refresh?.bind(slot.strategy);
  }

  async #isUsable(slot: Slot, config: unknown, held: Held): Promise<boolean> {
    return !this.#isExpired(held) && (await this.#passesProbe(slot, config, held.credential));
  }

  async #passesProbe(slot: Slot, config: unknown, credential: JsonValue): Promise<boolean> {
    return slot.strategy.probe === undefined || slot.strategy.probe(credential, config, this.#context(slot.identity));
  }

  #isExpired(held: Held): boolean {
    return held.expiresAt !== undefined && held.expiresAt.getTime() <= this.#deps.now().getTime();
  }

  /** Saves a new credential, unless the strategy holds static secrets, and keeps it. */
  async #adopt(slot: Slot, credential: JsonValue): Promise<Held> {
    const held: Held = { credential, expiresAt: slot.strategy.expiresAt?.(credential) };
    if (slot.strategy.cacheable) await this.#deps.cache.save(slot.key, credential, held.expiresAt);
    return this.#keep(slot, held);
  }

  #keep(slot: Slot, held: Held): Held {
    for (const value of slot.strategy.secrets(held.credential)) this.#deps.redactor.register(value);
    this.#held.set(slot.id, held);
    return held;
  }

  async #loadCached(slot: Slot): Promise<Held | undefined> {
    if (!slot.strategy.cacheable) return undefined;
    const cached = await this.#deps.cache.load(slot.key);
    if (cached === undefined) return undefined;
    return { credential: cached.credential, expiresAt: cached.expiresAt === undefined ? undefined : new Date(cached.expiresAt) };
  }

  #config(slot: Slot): Promise<unknown> {
    let config = this.#configs.get(slot.id);
    if (config === undefined) {
      config = this.#parseSettings(slot);
      this.#configs.set(slot.id, config);
      // a secret lookup that failed, such as an op read timeout, may work on the next call
      config.catch(() => this.#configs.delete(slot.id));
    }
    return config;
  }

  async #parseSettings(slot: Slot): Promise<unknown> {
    const parsed = slot.strategy.config.safeParse(await this.#deps.resolve(slot.settings));
    if (!parsed.success) throw new Error(`${slot.id} has invalid ${slot.strategy.name} settings: ${z.prettifyError(parsed.error)}`);
    return parsed.data;
  }

  #slot(identity: string, surface: string): Slot {
    const config = this.#deps.configs[identity];
    if (config === undefined) {
      throw new Error(`unknown identity "${identity}"; known: ${Object.keys(this.#deps.configs).join(", ") || "none"}`);
    }
    const auth = config.auth[surface];
    if (auth === undefined) throw new Error(`identity "${identity}" has no auth for surface "${surface}"`);
    const owner = "from" in auth ? auth.from : surface;
    const settings = config.auth[owner];
    if (settings === undefined || "from" in settings) {
      throw new Error(`surface "${surface}" of identity "${identity}" takes from: a surface with no settings of its own`);
    }
    return {
      id: `${identity}/${owner}`,
      identity,
      key: { env: this.#deps.env.name, identity, surface: owner, strategy: settings.strategy },
      strategy: this.#deps.registry.strategy(settings.strategy),
      settings: settings.with,
    };
  }

  #context(identity: string): AuthContext {
    const ctx: AuthContext = {
      identity,
      fields: this.#fields(identity),
      env: this.#deps.env,
      http: this.#http,
      projectRoot: this.#deps.projectRoot,
      person: this.#deps.channel,
      now: () => this.#deps.now(),
    };
    if (this.#deps.browser !== undefined) ctx.browser = this.#deps.browser;
    return ctx;
  }

  #fields(identity: string): Readonly<Record<string, string>> {
    const fixture = this.#deps.configs[identity]?.fixture;
    if (fixture === undefined) return {};
    const fields = this.#deps.fixtures[fixture];
    if (fields === undefined) throw new Error(`identity "${identity}" names fixture "${fixture}", which the fixtures do not have`);
    return fields;
  }
}

/** Compares as the cache stores credentials, where a field set to undefined is left out. */
function isSameCredential(a: Held, b: Held | undefined): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}
