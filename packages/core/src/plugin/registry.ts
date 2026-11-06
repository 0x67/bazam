import { createRequire } from "node:module";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";
import { BRAND } from "../brand.ts";
import type { Driver, StepHandler } from "../driver/index.ts";
import type { SecretProvider } from "../secrets/index.ts";
import { builtinContributions, type BuiltinConfig } from "./builtin.ts";

export const PLUGIN_API_VERSION = 1;
const CORE_PLUGIN = `${BRAND.scope}/core`;
// the kinds buildStepSchema builds in (see case/schema.ts::buildStepSchema); a plugin handler would replace them
const CORE_STEP_KINDS: ReadonlySet<string> = new Set(["use", "request", "challenge", "guided", "note"]);
const STEP_KIND = "step kind";

export interface PluginManifest {
  name: string;
  apiVersion: number;
  drivers?: Driver[];
  steps?: StepHandler[];
  secretProviders?: SecretProvider[];
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
    super(`plugin "${plugin}" needs plugin API version ${apiVersion}; ${CORE_PLUGIN} provides version ${PLUGIN_API_VERSION}`);
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
  name(item: T): string;
}

// Adding a contribution type takes a manifest field, an entry here and a lookup method.
const contributionLists: { [K in ContributionKey]: ContributionList<Contribution<K>> } = {
  drivers: { noun: "driver target", name: (driver) => driver.target },
  secretProviders: { noun: "secret provider", name: (provider) => provider.name },
};
const CONTRIBUTION_KEYS = Object.keys(contributionLists) as ContributionKey[];

interface Registered<T> {
  item: T;
  plugin: string;
}

interface RegisteredStep extends Registered<StepHandler> {
  /** Undefined for a plugin step. */
  driver: Driver | undefined;
}

type Registrations = { [K in ContributionKey]: Map<string, Registered<Contribution<K>>> };

export class PluginRegistry {
  readonly #registrations = Object.fromEntries(CONTRIBUTION_KEYS.map((key) => [key, new Map()])) as Registrations;
  readonly #steps = new Map<string, RegisteredStep>();

  private constructor() {}

  /** Registers the core plugin, then `defaults`, then each entry of `config.plugins` in order. */
  static async load(
    config: BuiltinConfig & { plugins?: readonly string[] },
    projectRoot: string,
    defaults: readonly PluginManifest[],
  ): Promise<PluginRegistry> {
    const root = resolve(projectRoot);
    const registry = new PluginRegistry();
    registry.#add({ name: CORE_PLUGIN, apiVersion: PLUGIN_API_VERSION, ...builtinContributions(config, root) });
    for (const manifest of defaults) registry.#add(manifest);
    for (const entry of config.plugins ?? []) registry.#add(manifestOf(await importPlugin(entry, root), entry));
    return registry;
  }

  driver(target: string): Driver {
    return this.#get("drivers", target);
  }

  /** In the order of `names`; an unknown name throws, so a typo in config never drops a provider. */
  secretProviders(names: readonly string[]): SecretProvider[] {
    return names.map((name) => this.#get("secretProviders", name));
  }

  /** One handler per kind; a kind that several drivers offer comes from the first of them. */
  stepHandlers(): readonly StepHandler[] {
    return [...this.#steps.values()].map((registered) => registered.item);
  }

  #add(manifest: PluginManifest): void {
    if (manifest.apiVersion !== PLUGIN_API_VERSION) throw new PluginApiMismatch(manifest.name, manifest.apiVersion);
    for (const key of CONTRIBUTION_KEYS) this.#addList(key, manifest);
    for (const [kind, step] of namedItems(manifest.name, "steps", manifest.steps, STEP_KIND, stepKind)) {
      this.#addStep(kind, { item: step, plugin: manifest.name, driver: undefined });
    }
    for (const driver of manifest.drivers ?? []) {
      const field = `steps of driver "${driver.target}"`;
      for (const [kind, step] of namedItems(manifest.name, field, driver.steps, STEP_KIND, stepKind)) {
        this.#addStep(kind, { item: step, plugin: manifest.name, driver });
      }
    }
  }

  #addList<K extends ContributionKey>(key: K, manifest: PluginManifest): void {
    const list = contributionLists[key];
    const registrations = this.#registrations[key];
    for (const [name, item] of namedItems(manifest.name, key, manifest[key], list.noun, list.name)) {
      const earlier = registrations.get(name);
      if (earlier !== undefined) throw new PluginConflict(`${list.noun} "${name}"`, [earlier.plugin, manifest.name]);
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
    // each driver runs its own target, so two drivers may both offer open or tap
    const fromTwoDrivers = earlier.driver !== undefined && step.driver !== undefined && earlier.driver !== step.driver;
    if (!fromTwoDrivers) throw new PluginConflict(`${STEP_KIND} "${kind}"`, [earlier.plugin, step.plugin]);
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
function namedItems<T>(plugin: string, field: string, value: unknown, noun: string, name: (item: T) => string): [string, T][] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw new Error(`plugin "${plugin}": ${field} is not a list`);
  return value.map((item: T) => {
    const itemName: unknown = typeof item === "object" && item !== null ? name(item) : undefined;
    if (typeof itemName !== "string" || itemName === "") throw new Error(`plugin "${plugin}" has an entry with no ${noun}`);
    return [itemName, item];
  });
}

async function importPlugin(entry: string, root: string): Promise<unknown> {
  const file = entry.startsWith(".") || isAbsolute(entry) ? pathInside(root, entry) : packageEntry(root, entry);
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
  if (name.includes("\\") || name.split("/").some((segment) => segment === "" || segment === "." || segment === "..")) {
    throw new Error(`plugin "${name}" is neither a package name nor a path that starts with "."`);
  }
  // createRequire resolves from the folder of the file it is given; that file need not exist
  return createRequire(resolve(root, "package.json")).resolve(name);
}

function manifestOf(value: unknown, entry: string): PluginManifest {
  const manifest = value as Partial<Record<keyof PluginManifest, unknown>> | null | undefined;
  if (typeof manifest?.name !== "string" || manifest.name === "" || typeof manifest.apiVersion !== "number") {
    throw new Error(`plugin "${entry}" has no default export with a name and an apiVersion`);
  }
  return manifest as PluginManifest;
}
