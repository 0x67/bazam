import { createRequire } from "node:module";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";
import type { AuthStrategy, JsonValue } from "../auth/index.ts";
import { BRAND } from "../brand.ts";
import {
  assertHumanOnly,
  type ChallengeKindSpec,
  type ChallengeResolver,
  type HumanChannel,
} from "../challenge/index.ts";
import type { CheckRule } from "../check/index.ts";
import type { Driver, StepHandler } from "../driver/index.ts";
import type { Environment } from "../env/index.ts";
import type { ResultFormat } from "../ingest/index.ts";
import { declaredSecretNames, type ProjectConfig } from "../project.ts";
import { defaultRedactionRules, Redactor } from "../redact/index.ts";
import { markdownTracker, type TrackerClient, type TrackerRenderer } from "../report/index.ts";
import type { PlanCheck } from "../run/plan-checks.ts";
import type { SecretProvider } from "../secrets/index.ts";
import { builtinContributions } from "./builtin.ts";
import { startProcessPlugin, type ProcessPlugin } from "./process.ts";

export const PLUGIN_API_VERSION = 1;
const CORE_PLUGIN = `${BRAND.scope}/core`;
// the kinds buildStepSchema builds in (see case/schema.ts::buildStepSchema), which a plugin handler would replace,
// and the api check from driver/http.ts::httpSteps
const CORE_STEP_KINDS: ReadonlySet<string> = new Set([
  "use",
  "request",
  "challenge",
  "guided",
  "note",
  "followup",
  "api",
]);
const STEP_KIND = "step kind";

export interface PluginManifest {
  name: string;
  apiVersion: number;
  drivers?: Driver[];
  steps?: StepHandler[];
  // any: each strategy has its own config and credential types
  authStrategies?: AuthStrategy<any, any>[];
  resolvers?: ChallengeResolver[];
  challengeKinds?: ChallengeKindSpec[];
  secretProviders?: SecretProvider[];
  channels?: { name: string; create(runDir: string): HumanChannel }[];
  trackers?: TrackerRenderer[];
  checkRules?: CheckRule[];
  resultFormats?: ResultFormat[];
  trackerClients?: TrackerClient[];
  planChecks?: PlanCheck[];
}

export function definePlugin(manifest: PluginManifest): PluginManifest {
  return manifest;
}

/** Two contributions of one type share a name. */
export class PluginConflict extends Error {
  readonly plugins: readonly [string, string];

  constructor(contribution: string, plugins: readonly [string, string]) {
    super(`${contribution} comes from both plugin "${plugins[0]}" and plugin "${plugins[1]}"`);
    this.name = "PluginConflict";
    this.plugins = plugins;
  }
}

/** A plugin built for another major version of the plugin API. */
export class PluginApiMismatch extends Error {
  readonly plugin: string;
  readonly apiVersion: number;

  constructor(plugin: string, apiVersion: number) {
    super(
      `plugin "${plugin}" needs plugin API version ${apiVersion}; ${CORE_PLUGIN} provides version ${PLUGIN_API_VERSION}`,
    );
    this.name = "PluginApiMismatch";
    this.plugin = plugin;
    this.apiVersion = apiVersion;
  }
}

// steps are left out: drivers may share a kind and core keeps its own kinds
type ContributionKey = Exclude<keyof PluginManifest, "name" | "apiVersion" | "steps">;
type Contribution<K extends ContributionKey> = NonNullable<PluginManifest[K]>[number];

interface ContributionList<T> {
  /** What the name of one item is called in messages. */
  noun: string;
  name: (item: T) => string;
}

// Adding a contribution type takes a manifest field, an entry here and a lookup method.
const contributionLists: { [K in ContributionKey]: ContributionList<Contribution<K>> } = {
  drivers: { noun: "driver", name: (driver) => driver.name },
  authStrategies: { noun: "auth strategy", name: (strategy) => strategy.name },
  resolvers: { noun: "challenge resolver", name: (resolver) => resolver.name },
  challengeKinds: { noun: "challenge kind", name: (kind) => kind.name },
  secretProviders: { noun: "secret provider", name: (provider) => provider.name },
  channels: { noun: "human channel", name: (channel) => channel.name },
  trackers: { noun: "tracker renderer", name: (renderer) => renderer.tracker },
  checkRules: { noun: "check rule", name: (rule) => rule.id },
  resultFormats: { noun: "result format", name: (format) => format.name },
  trackerClients: { noun: "tracker client", name: (client) => client.tracker },
  planChecks: { noun: "plan check", name: (check) => check.name },
};
const CONTRIBUTION_KEYS = Object.keys(contributionLists) as ContributionKey[];

interface Registered<T> {
  item: T;
  plugin: string;
}

interface RegisteredStep extends Registered<StepHandler> {
  /** Undefined for a core or plugin step, which no driver owns. */
  driver: Driver | undefined;
}

type Registrations = { [K in ContributionKey]: Map<string, Registered<Contribution<K>>> };

export class PluginRegistry {
  readonly #registrations = Object.fromEntries(
    CONTRIBUTION_KEYS.map((key) => [key, new Map()]),
  ) as Registrations;
  readonly #steps = new Map<string, RegisteredStep>();
  readonly #humanOnlyKinds: ReadonlySet<string>;
  readonly #processes: ProcessPlugin[] = [];

  private constructor(humanOnlyKinds: ReadonlySet<string>) {
    this.#humanOnlyKinds = humanOnlyKinds;
  }

  /**
   * Registers the core plugin, then `defaults`, then each entry of `config.plugins` in order, starting a process for
   * each object entry. `log` gets the stderr and `host.log` lines of process plugins and must mask them; `redactor`
   * masks the stderr lines a failed start quotes. A load that fails closes the processes it started.
   */
  static async load(
    config: ProjectConfig,
    projectRoot: string,
    defaults: readonly PluginManifest[],
    options: { log?(line: string): void; redactor?: Redactor } = {},
  ): Promise<PluginRegistry> {
    const root = resolve(projectRoot);
    const registry = new PluginRegistry(new Set(config.challenges.humanOnly));
    registry.#add({
      name: CORE_PLUGIN,
      apiVersion: PLUGIN_API_VERSION,
      ...builtinContributions(config, root),
    });
    for (const manifest of defaults) registry.#add(manifest);
    let redactor: Redactor | undefined;
    try {
      for (const entry of config.plugins) {
        if (typeof entry === "string") {
          registry.#add(manifestOf(await importPlugin(entry, root), entry));
          continue;
        }
        redactor ??= processRedactor(config, options.redactor);
        const plugin = await startProcessPlugin(entry, {
          root,
          apiVersion: PLUGIN_API_VERSION,
          log: (line) => options.log?.(line),
          redactor,
        });
        registry.#processes.push(plugin);
        registry.#add(plugin.manifest);
      }
    } catch (error) {
      await registry.close();
      throw error;
    }
    return registry;
  }

  /** Ends every process plugin; safe to call twice. */
  async close(): Promise<void> {
    await Promise.all(this.#processes.splice(0).map((plugin) => plugin.close()));
  }

  driver(name: string): Driver {
    return this.#get("drivers", name);
  }

  strategy(name: string): AuthStrategy<unknown, JsonValue> {
    return this.#get("authStrategies", name);
  }

  /** A kind that config lists under `challenges.humanOnly` is human-only whatever its plugin says. */
  kind(name: string): ChallengeKindSpec {
    const spec = this.#get("challengeKinds", name);
    return this.#humanOnlyKinds.has(name) && !spec.humanOnly ? { ...spec, humanOnly: true } : spec;
  }

  resolver(name: string): ChallengeResolver {
    return this.#get("resolvers", name);
  }

  /**
   * The resolvers `env` lists for the kind, in order. A kind the env lists none for gets an empty chain,
   * which blocks its cases, so a person is asked only where the env names human.
   */
  resolverChain(env: Environment, kind: string): ChallengeResolver[] {
    const spec = this.kind(kind);
    const chain = (env.challenges[kind] ?? []).map((name) => {
      const resolver = this.resolver(name);
      if (!resolver.kinds.includes("*") && !resolver.kinds.includes(kind)) {
        throw new Error(
          `env ${env.name} lists resolver "${name}" for challenge ${kind}, but it answers only ${resolver.kinds.join(", ")}`,
        );
      }
      return resolver;
    });
    assertHumanOnly(spec, chain);
    return chain;
  }

  /** In the order of `names`; an unknown name throws, so a typo in config never drops a provider. */
  secretProviders(names: readonly string[]): SecretProvider[] {
    return names.map((name) => this.#get("secretProviders", name));
  }

  channel(name: string): (runDir: string) => HumanChannel {
    const channel = this.#get("channels", name);
    return (runDir) => channel.create(runDir);
  }

  /** The renderer a plugin registered for the tracker, or plain Markdown when none did. */
  tracker(name: string): TrackerRenderer {
    return this.#registrations.trackers.get(name)?.item ?? markdownTracker(name);
  }

  resultFormat(name: string): ResultFormat {
    return this.#get("resultFormats", name);
  }

  trackerClient(name: string): TrackerClient {
    return this.#get("trackerClients", name);
  }

  /** One handler per kind; a kind that several drivers offer comes from the first of them. */
  stepHandlers(): readonly StepHandler[] {
    return [...this.#steps.values()].map((registered) => registered.item);
  }

  /** What a step of `kind` runs with in a session of `driver`: the driver's own handler, else a core or plugin step. */
  stepHandler(kind: string, driver: Driver): StepHandler | undefined {
    const own = driver.steps.find((handler) => handler.kind === kind);
    if (own !== undefined) return own;
    // a kind only other drivers offer has no handler here
    const registered = this.#steps.get(kind);
    return registered?.driver === undefined ? registered?.item : undefined;
  }

  /** The built-in rules, then each plugin's, in the order the plugins loaded. */
  checkRules(): readonly CheckRule[] {
    return [...this.#registrations.checkRules.values()].map((registered) => registered.item);
  }

  /** Every registered plan check, in the order the plugins loaded. */
  planChecks(): readonly PlanCheck[] {
    return [...this.#registrations.planChecks.values()].map((registered) => registered.item);
  }

  #add(manifest: PluginManifest): void {
    if (manifest.apiVersion !== PLUGIN_API_VERSION)
      throw new PluginApiMismatch(manifest.name, manifest.apiVersion);
    for (const key of CONTRIBUTION_KEYS) this.#addList(key, manifest);
    for (const [kind, step] of namedItems(
      manifest.name,
      "steps",
      manifest.steps,
      STEP_KIND,
      stepKind,
    )) {
      this.#addStep(kind, { item: step, plugin: manifest.name, driver: undefined });
    }
    for (const driver of manifest.drivers ?? []) {
      const field = `steps of driver "${driver.name}"`;
      for (const [kind, step] of namedItems(
        manifest.name,
        field,
        driver.steps,
        STEP_KIND,
        stepKind,
      )) {
        this.#addStep(kind, { item: step, plugin: manifest.name, driver });
      }
    }
  }

  #addList<K extends ContributionKey>(key: K, manifest: PluginManifest): void {
    const list = contributionLists[key];
    const registrations = this.#registrations[key];
    for (const [name, item] of namedItems(
      manifest.name,
      key,
      manifest[key],
      list.noun,
      list.name,
    )) {
      const earlier = registrations.get(name);
      if (earlier !== undefined)
        throw new PluginConflict(`${list.noun} "${name}"`, [earlier.plugin, manifest.name]);
      registrations.set(name, { item, plugin: manifest.name });
    }
  }

  #addStep(kind: string, step: RegisteredStep): void {
    if (CORE_STEP_KINDS.has(kind) && step.plugin !== CORE_PLUGIN) {
      throw new PluginConflict(`${STEP_KIND} "${kind}"`, [CORE_PLUGIN, step.plugin]);
    }
    const earlier = this.#steps.get(kind);
    if (earlier === undefined) {
      this.#steps.set(kind, step);
      return;
    }
    // the runner sends a driver step to the driver of the case's target, so two drivers may both offer open or tap
    const fromTwoDrivers =
      earlier.driver !== undefined && step.driver !== undefined && earlier.driver !== step.driver;
    if (!fromTwoDrivers)
      throw new PluginConflict(`${STEP_KIND} "${kind}"`, [earlier.plugin, step.plugin]);
  }

  #get<K extends ContributionKey>(key: K, name: string): Contribution<K> {
    const registered = this.#registrations[key].get(name);
    if (registered === undefined) {
      const known = [...this.#registrations[key].keys()].join(", ") || "none";
      throw new Error(`unknown ${contributionLists[key].noun} "${name}"; known: ${known}`);
    }
    return registered.item;
  }
}

function stepKind(step: StepHandler): string {
  return step.kind;
}

/** Checks that `value` is a list whose items each have a non-empty name, and pairs each name with its item. */
function namedItems<T>(
  plugin: string,
  field: string,
  value: unknown,
  noun: string,
  name: (item: T) => string,
): [string, T][] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw new Error(`plugin "${plugin}": ${field} is not a list`);
  return value.map((item: T) => {
    const itemName: unknown = typeof item === "object" && item !== null ? name(item) : undefined;
    if (typeof itemName !== "string" || itemName === "")
      throw new Error(
        `plugin "${plugin}": an entry in ${field} cannot be registered as a ${noun} because its identifier is missing or empty`,
      );
    return [itemName, item];
  });
}

async function importPlugin(entry: string, root: string): Promise<unknown> {
  const file =
    entry.startsWith(".") || isAbsolute(entry)
      ? pathInside(root, entry)
      : packageEntry(root, entry);
  const module: { default?: unknown } = await import(pathToFileURL(file).href);
  return module.default;
}

function pathInside(root: string, entry: string): string {
  const file = resolve(root, entry);
  const fromRoot = relative(root, file);
  if (fromRoot === ".." || fromRoot.startsWith(`..${sep}`) || isAbsolute(fromRoot)) {
    throw new Error(`plugin path "${entry}" is outside the project root ${root}`);
  }
  return file;
}

function packageEntry(root: string, name: string): string {
  // the resolver joins a name it finds no package for onto each node_modules folder, so ".." could reach any file
  if (
    name.includes("\\") ||
    name.split("/").some((segment) => segment === "" || segment === "." || segment === "..")
  ) {
    throw new Error(`plugin "${name}" is neither a package name nor a path that starts with "."`);
  }
  // createRequire resolves from the folder of the file it is given; that file need not exist
  return createRequire(resolve(root, "package.json")).resolve(name);
}

/**
 * The redactor that masks process plugin stderr, with the `process.env` value of each declared secret registered,
 * since every process plugin inherits `process.env`.
 */
function processRedactor(config: ProjectConfig, given: Redactor | undefined): Redactor {
  let redactor = given;
  if (redactor === undefined) {
    redactor = new Redactor(defaultRedactionRules());
    redactor.configure(config.redaction);
  }
  for (const name of declaredSecretNames(config)) {
    const value = process.env[name];
    if (value) redactor.register(value);
  }
  return redactor;
}

function manifestOf(value: unknown, entry: string): PluginManifest {
  const manifest = value as Partial<Record<keyof PluginManifest, unknown>> | null | undefined;
  if (
    typeof manifest?.name !== "string" ||
    manifest.name === "" ||
    typeof manifest.apiVersion !== "number"
  ) {
    throw new Error(`plugin "${entry}" has no default export with a name and an apiVersion`);
  }
  return manifest as PluginManifest;
}
