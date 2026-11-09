import { execFile } from "node:child_process";
import { readdir, readFile } from "node:fs/promises";
import { join, posix, resolve } from "node:path";
import { promisify } from "node:util";
import { isMap, isNode, isScalar, isSeq, LineCounter, parseDocument, type Document } from "yaml";
import { z } from "zod";
import { IdentitiesConfig } from "./auth/index.ts";
import { BRAND } from "./brand.ts";
import {
  buildCaseSchema,
  buildStepSchema,
  loadCases,
  SuitesFile,
  type CaseFilter,
  type CaseSpec,
  type FlowSpec,
  type LoadedCase,
  type LoadIssue,
  type SourceSpan,
  type Step,
} from "./case/index.ts";
import type { ChallengeKindSpec, ChallengeResolver } from "./challenge/index.ts";
import { EnvsConfig, findPlaceholders } from "./env/index.ts";
import { MappingFile } from "./ingest/mapping.ts";
import type { PluginRegistry } from "./plugin/index.ts";
import { RedactionConfig } from "./redact/index.ts";

const SUITES_FILE = "suites.yaml";
const MAPPING_RULE = "runner-mapping-valid";
const SYNTAX_FIX = "Fix the YAML syntax on this line.";
const execFileAsync = promisify(execFile);

/** Folders that stay out of git: run results and local state such as cached credentials. */
export const STATE_DIRS: readonly string[] = ["runs", BRAND.stateDir];

// a runner target's name names its folder runs/<run-id>/runner-<target>/, and a runner's name goes into a prompt id
const PLAIN_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const PLAIN_NAME_RULE = "letters, digits, dots, dashes and underscores, starting with a letter or digit";
const SITE_HOST = /^[a-z0-9-]+(\.[a-z0-9-]+)*(:[0-9]+)?$/;
const LOOPBACK_HOSTS: ReadonlySet<string> = new Set(["127.0.0.1", "localhost"]);

/** An external suite that runs for the targets that name it. */
export const RunnerConfig = z.strictObject({
  /** The argv, run without a shell. */
  command: z.array(z.string().min(1)).min(1),
  /** Relative to the project root. */
  cwd: z.string().min(1).default("."),
  /** A glob relative to `cwd`. */
  results: z.string().min(1),
  /** A result format the registry knows. */
  format: z.string().min(1),
  /** Relative to the project root. */
  mapping: z.string().min(1).optional(),
  env: z.record(z.string().min(1), z.string()).default({}),
  timeoutMinutes: z.number().positive().default(60),
  /**
   * Runs it in a production env without asking. Without it the run asks first, because it cannot hold the suite's
   * process to the host allowlist or the write guard.
   */
  prodSafe: z.boolean().default(false),
  /** The identities its tests act as; every identity in the config when left out. */
  identities: z.array(z.string().min(1)).optional(),
});
export type RunnerConfig = z.infer<typeof RunnerConfig>;

const DriverTarget = z.object({ driver: z.string().min(1) }).catchall(z.json());
const RunnerTarget = z.strictObject({
  runner: z.string().min(1),
  env: z.record(z.string().min(1), z.string()).default({}),
});

/** A plugin that runs as its own process and talks to the host over stdio. */
export const ProcessPluginEntry = z.strictObject({
  command: z.array(z.string().min(1)).min(1),
  /** Relative to the project root. */
  cwd: z.string().min(1).default("."),
  /** Added to this process's environment. */
  env: z.record(z.string().min(1), z.string()).default({}),
  /** Per call, from the host's side. */
  timeoutSeconds: z.int().positive().default(600),
});
export type ProcessPluginEntry = z.infer<typeof ProcessPluginEntry>;

const TrackerProject = z.strictObject({
  transitions: z.partialRecord(z.enum(["pass", "fail", "blocked", "followup"]), z.string().min(1)).default({}),
  bugs: z
    .strictObject({
      issueType: z.string().min(1),
      labels: z.array(z.string().min(1)).default([]),
      onPass: z.string().min(1).optional(),
      linkType: z.string().min(1).default("Relates"),
    })
    .optional(),
  promoteOn: z.array(z.string().min(1)).default([]),
});

export const TrackerConfig = z.strictObject({
  /** `host[:port]`; https is implied, except for a 127.0.0.1 or localhost site with a port, which tests use. */
  site: z
    .string()
    .refine(isSiteHost, {
      error:
        "site takes a lowercase host and an optional port other than 443, such as example.atlassian.net, with no scheme, credentials, path, query or fragment",
    })
    .optional(),
  /** The REST base when it is not `https://<site>`, such as a scoped token's. */
  api: z
    .url({ abort: true })
    .refine(isTrackerApi, { error: "api must be an https URL; http only for 127.0.0.1 or localhost with a port" })
    .optional(),
  /** Secret names, read through `secrets.providers`. */
  secrets: z.record(z.string().min(1), z.string().min(1)).default({}),
  projects: z.record(z.string().min(1), TrackerProject).default({}),
});
export type TrackerConfig = z.infer<typeof TrackerConfig>;

/** The project config file. */
export const ProjectConfig = z
  .strictObject({
    envs: EnvsConfig,
    secrets: z
      .strictObject({
        /** Provider names in the order they are asked. */
        providers: z.array(z.string().min(1)).default(["env", "dotenv"]),
        /** The secret names cases may use as `${secret.NAME}`. */
        names: z.array(z.string().min(1)).default([]),
        /** 1Password references by secret name. */
        refs: z.record(z.string(), z.string().min(1)).default({}),
      })
      .prefault({}),
    identities: IdentitiesConfig.default({}),
    challenges: z
      .strictObject({
        /** Kinds that only a person may answer, such as an MPIN on a real account. */
        humanOnly: z.array(z.string().min(1)).default([]),
      })
      .prefault({}),
    runners: z.record(z.string().min(1), RunnerConfig).default({}),
    /**
     * Per case target: `driver` names its driver, which gets the other settings, such as browser and headless;
     * `runner` names a runner, whose env the target's `env` extends.
     */
    targets: z
      .record(
        z.string().min(1),
        z.union([RunnerTarget, DriverTarget], {
          // a runner target with a bad field fails both options, so report the runner option's own issue
          error: (issue) => {
            const own =
              issue.code === "invalid_union" &&
              typeof issue.input === "object" &&
              issue.input !== null &&
              "runner" in issue.input
                ? issue.errors[0]?.[0]
                : undefined;
            return own === undefined ? "a target needs driver or runner" : `${own.path.join(".")}: ${own.message}`;
          },
        }),
      )
      .default({}),
    /** Where results are posted, and the default transitions per tracker project. */
    trackers: z.record(z.string().min(1), TrackerConfig).default({}),
    plugins: z
      .array(
        z.union([z.string().min(1), ProcessPluginEntry], {
          error:
            "a plugin entry is a module path, or an object whose command is an argv list such as [python3, plugins/otp_hook.py]",
        }),
      )
      .default([]),
    /** Patterns and screenshot selectors masked on top of the built-in rules. */
    redaction: RedactionConfig.prefault({}),
  })
  .superRefine((config, ctx) => {
    for (const [name, runner] of Object.entries(config.runners)) {
      if (!PLAIN_NAME.test(name)) {
        ctx.addIssue({ code: "custom", path: ["runners", name], message: `a runner name takes ${PLAIN_NAME_RULE}` });
      }
      runner.identities?.forEach((identity, index) => {
        if (identity === "" || Object.hasOwn(config.identities, identity)) return;
        ctx.addIssue({
          code: "custom",
          path: ["runners", name, "identities", index],
          message: `runner ${name} lists identity ${identity}, which identities does not define`,
        });
      });
    }
    for (const [name, target] of Object.entries(config.targets)) {
      if ("driver" in target) {
        if ("runner" in target) {
          ctx.addIssue({
            code: "custom",
            path: ["targets", name],
            message: "a target names a driver or a runner, not both",
          });
        }
        continue;
      }
      if (!PLAIN_NAME.test(name)) {
        ctx.addIssue({
          code: "custom",
          path: ["targets", name],
          message: `a runner target's name takes ${PLAIN_NAME_RULE}`,
        });
      }
      if (target.runner !== "" && !Object.hasOwn(config.runners, target.runner)) {
        ctx.addIssue({
          code: "custom",
          path: ["targets", name, "runner"],
          message: `runner ${target.runner} is not defined under runners`,
        });
      }
    }
  });
export type ProjectConfig = z.infer<typeof ProjectConfig>;

/** The runner a runner target names, with the target's env; undefined for a driver target or an unknown target. */
export function runnerOf(
  config: ProjectConfig,
  target: string,
): { name: string; runner: RunnerConfig; env: Record<string, string> } | undefined {
  const entry = Object.hasOwn(config.targets, target) ? config.targets[target] : undefined;
  if (entry === undefined || "driver" in entry) return undefined;
  const runner = Object.hasOwn(config.runners, entry.runner) ? config.runners[entry.runner] : undefined;
  return runner === undefined ? undefined : { name: entry.runner, runner, env: entry.env };
}

/**
 * Why a case that lists a runner target cannot run: it also lists a driver target, or it has steps or checks.
 * `field` names the case field at fault. Undefined for a case with no runner target.
 */
export function externalCaseProblem(
  config: ProjectConfig,
  spec: CaseSpec,
): { field: "targets" | "steps" | "checks"; message: string } | undefined {
  const runnerTargets = spec.targets.filter((target) => runnerOf(config, target) !== undefined);
  if (runnerTargets.length === 0) return undefined;
  const driverTargets = spec.targets.filter(
    (target) => Object.hasOwn(config.targets, target) && "driver" in config.targets[target]!,
  );
  if (driverTargets.length > 0) {
    return {
      field: "targets",
      message: `${spec.id} lists runner targets (${runnerTargets.join(", ")}) and driver targets (${driverTargets.join(", ")})`,
    };
  }
  const field = spec.steps.length > 0 ? "steps" : spec.checks.length > 0 ? "checks" : undefined;
  if (field === undefined) return undefined;
  return { field, message: `${spec.id} runs on runner target ${runnerTargets[0]} but has ${field}` };
}

const SECRET_PLACEHOLDER = /^\$\{secret\.(.+)\}$/;

/**
 * The secret names whose inherited environment values the redactor masks before a child process starts:
 * `secrets.names`, every value of `trackers.<t>.secrets`, then each `${secret.NAME}` under `identities`, each once.
 */
export function declaredSecretNames(config: ProjectConfig): string[] {
  const names = new Set(config.secrets.names);
  for (const tracker of Object.values(config.trackers))
    for (const name of Object.values(tracker.secrets)) names.add(name);
  for (const placeholder of findPlaceholders(config.identities)) {
    const name = SECRET_PLACEHOLDER.exec(placeholder)?.[1];
    if (name !== undefined) names.add(name);
  }
  return [...names];
}

function isSiteHost(site: string): boolean {
  // a port over 65535 matches the pattern but does not parse
  return SITE_HOST.test(site) && URL.canParse(`https://${site}`) && new URL(`https://${site}`).host === site;
}

function isTrackerApi(api: string): boolean {
  if (!URL.canParse(api)) return false;
  const url = new URL(api);
  return url.protocol === "https:" || (url.protocol === "http:" && LOOPBACK_HOSTS.has(url.hostname) && url.port !== "");
}

export const FIXTURES_FILE = "fixtures/identities.example.yaml";

/** Identity fields by fixture entry name, as `fixtures/identities.example.yaml` and its local copy hold them. */
export const IdentityFixtures = z.record(z.string().min(1), z.record(z.string().min(1), z.string()));
export type IdentityFixtures = z.infer<typeof IdentityFixtures>;

function flowFileSchema(step: z.ZodType<Step>) {
  return z.strictObject({
    flows: z.array(
      z.strictObject({
        name: z.string().min(1),
        params: z.array(z.string().min(1)).default([]),
        steps: z.array(step).min(1),
      }),
    ),
  });
}

/** A YAML file of the project with what is needed to find the line of any node in it. */
export interface ProjectFile {
  /** Relative to the project root, with forward slashes. */
  path: string;
  text: string;
  doc: Document.Parsed;
  lines: LineCounter;
}

/** A runner's mapping file: test title, without the project prefix, to case id. */
export type RunnerMapping = z.infer<typeof MappingFile>;

export interface LoadedFlow extends FlowSpec {
  source: SourceSpan;
}

export interface Project {
  root: string;
  config: ProjectConfig;
  /** The cases that loaded without issues. */
  cases: readonly LoadedCase[];
  flows: ReadonlyMap<string, LoadedFlow>;
  suites: ReadonlyMap<string, CaseFilter>;
  /** From `fixtures/identities.example.yaml`. */
  fixtures: IdentityFixtures;
  retiredIds: ReadonlySet<string>;
  /** Every challenge kind the config names, as the registry defines it. */
  challengeKinds: ReadonlyMap<string, ChallengeKindSpec>;
  /** Every resolver an env chain names that a plugin registered, as the registry defines it. */
  resolvers: ReadonlyMap<string, ChallengeResolver>;
  /** The result formats `runners` name that a plugin registered. */
  resultFormats: ReadonlySet<string>;
  /** The runner mapping files that loaded, by runner name. */
  mappings: ReadonlyMap<string, RunnerMapping>;
  /** Every YAML file that was read, by path. */
  files: ReadonlyMap<string, ProjectFile>;
  /** The `STATE_DIRS` that a `.gitignore` ignores, in the root or, inside a git repository, a parent folder. */
  ignoredStateDirs: ReadonlySet<string>;
  /** Problems found while loading, under the schema and id rules. */
  issues: readonly LoadIssue[];
}

export interface ConfigLoad {
  /** Undefined when the file is missing or does not match the schema. */
  config: ProjectConfig | undefined;
  issues: LoadIssue[];
}

/** Reads the config alone, which the plugin registry needs before the rest of the project can load. */
export async function loadProjectConfig(root: string): Promise<ConfigLoad> {
  const { config, issues } = await readConfig(root);
  return { config, issues };
}

/** Throws when the config has issues; `loadProjectConfig` reports them with their lines. */
export async function loadProject(root: string, registry: PluginRegistry): Promise<Project> {
  const configLoad = await readConfig(root);
  const { config, file: configFile } = configLoad;
  if (config === undefined || configFile === undefined) {
    const lines = configLoad.issues.map((issue) => `${issue.file}:${issue.line}: ${issue.message}`);
    throw new Error(`${BRAND.configFile} does not match the config schema:\n${lines.join("\n")}`);
  }
  const steps = registry.stepHandlers();
  const caseLoad = await loadCases(root, buildCaseSchema(steps));
  const caseFiles = await readAll(root, await caseFilePaths(root));
  const flows = await readFlows(root, buildStepSchema(steps));
  const suites = await readSuites(root);
  const fixtures = await readFixtures(root);
  const kinds = challengeKinds(config, configFile, registry);
  const mappings = await readMappings(root, config, configFile);
  const files = [configFile, ...caseFiles, ...flows.files, suites.file, fixtures.file, ...mappings.files].filter(
    (file) => file !== undefined,
  );
  return {
    root: resolve(root),
    config,
    cases: caseLoad.cases,
    flows: flows.flows,
    suites: suites.suites,
    fixtures: fixtures.fixtures,
    retiredIds: caseLoad.retiredIds,
    challengeKinds: kinds.kinds,
    resolvers: chainResolvers(config, registry),
    resultFormats: runnerFormats(config, registry),
    mappings: mappings.mappings,
    files: new Map(files.map((file) => [file.path, file])),
    ignoredStateDirs:
      (await gitIgnoredStateDirs(root)) ?? rootIgnoredStateDirs((await readText(join(root, ".gitignore"))) ?? ""),
    issues: [
      ...caseLoad.issues,
      ...flows.issues,
      ...suites.issues,
      ...fixtures.issues,
      ...kinds.issues,
      ...mappings.issues,
    ],
  };
}

/** Line of the deepest node on `path` that exists; a map entry counts from its key. */
export function lineAt(file: ProjectFile, path: readonly PropertyKey[]): number {
  let node: unknown = file.doc.contents;
  let offset = startOf(node) ?? 0;
  for (const segment of path) {
    if (isMap(node)) {
      const pair = node.items.find((item) => isScalar(item.key) && String(item.key.value) === String(segment));
      if (pair === undefined) break;
      offset = startOf(pair.key) ?? offset;
      node = pair.value;
    } else if (isSeq(node) && typeof segment === "number" && segment >= 0 && segment < node.items.length) {
      node = node.items[segment];
      offset = startOf(node) ?? offset;
    } else {
      break;
    }
  }
  return file.lines.linePos(offset).line;
}

async function readConfig(root: string): Promise<ConfigLoad & { file: ProjectFile | undefined }> {
  const file = await readProjectFile(root, BRAND.configFile);
  if (file === undefined) {
    const fix = `Run ${BRAND.name} init in the project root, or point at the folder that holds ${BRAND.configFile}.`;
    return {
      file,
      config: undefined,
      issues: [schemaIssue(BRAND.configFile, 1, `${BRAND.configFile} is missing`, fix)],
    };
  }
  const parsed = parseFile(file, ProjectConfig, "Edit this entry so it matches the config schema.");
  return { file, config: parsed.data, issues: parsed.issues };
}

async function caseFilePaths(root: string): Promise<string[]> {
  const domains = await readDir(join(root, "cases"));
  const paths: string[] = [];
  for (const domain of domains.filter((entry) => entry.isDirectory() && !entry.name.startsWith("."))) {
    const entries = await readDir(join(root, "cases", domain.name));
    for (const entry of entries.filter((e) => e.isFile() && e.name.endsWith(".yaml"))) {
      paths.push(posix.join("cases", domain.name, entry.name));
    }
  }
  return paths.sort();
}

async function readFlows(
  root: string,
  step: z.ZodType<Step>,
): Promise<{ flows: Map<string, LoadedFlow>; files: ProjectFile[]; issues: LoadIssue[] }> {
  const paths = (await readDir(join(root, "flows")))
    .filter((entry) => entry.isFile() && entry.name.endsWith(".yaml"))
    .map((entry) => posix.join("flows", entry.name))
    .sort();
  const files = await readAll(root, paths);
  const schema = flowFileSchema(step);
  const flows = new Map<string, LoadedFlow>();
  const issues: LoadIssue[] = [];
  for (const file of files) {
    const parsed = parseFile(file, schema, "Edit this entry so it matches the flow schema.");
    issues.push(...parsed.issues);
    parsed.data?.flows.forEach((flow, index) => {
      const source = { file: file.path, line: lineAt(file, ["flows", index]) };
      const first = flows.get(flow.name);
      if (first === undefined) {
        flows.set(flow.name, { ...flow, source });
        return;
      }
      const message = `flow ${flow.name} is already defined at ${first.source.file}:${first.source.line}`;
      issues.push(
        schemaIssue(
          file.path,
          lineAt(file, ["flows", index, "name"]),
          message,
          "Give this flow a name no other flow uses.",
        ),
      );
    });
  }
  return { flows, files, issues };
}

async function readSuites(
  root: string,
): Promise<{ suites: ReadonlyMap<string, CaseFilter>; file: ProjectFile | undefined; issues: LoadIssue[] }> {
  const file = await readProjectFile(root, SUITES_FILE);
  if (file === undefined) return { suites: new Map(), file, issues: [] };
  const parsed = parseFile(file, SuitesFile, "Edit suites.yaml so each suite maps filter fields to non-empty lists.");
  return { suites: new Map(Object.entries(parsed.data ?? {})), file, issues: parsed.issues };
}

async function readFixtures(
  root: string,
): Promise<{ fixtures: IdentityFixtures; file: ProjectFile | undefined; issues: LoadIssue[] }> {
  const file = await readProjectFile(root, FIXTURES_FILE);
  if (file === undefined) return { fixtures: {}, file, issues: [] };
  const parsed = parseFile(file, IdentityFixtures, "Give each fixture entry a mapping of field names to strings.");
  return { fixtures: parsed.data ?? {}, file, issues: parsed.issues };
}

function challengeKinds(
  config: ProjectConfig,
  configFile: ProjectFile,
  registry: PluginRegistry,
): { kinds: Map<string, ChallengeKindSpec>; issues: LoadIssue[] } {
  const kinds = new Map<string, ChallengeKindSpec>();
  const issues: LoadIssue[] = [];
  const named: [string, PropertyKey[]][] = [
    ...Object.entries(config.envs).flatMap(([env, { challenges }]) =>
      Object.keys(challenges).map((name): [string, PropertyKey[]] => [name, ["envs", env, "challenges", name]]),
    ),
    ...config.challenges.humanOnly.map((name, index): [string, PropertyKey[]] => [
      name,
      ["challenges", "humanOnly", index],
    ]),
  ];
  for (const [name, path] of named) {
    if (kinds.has(name)) continue;
    try {
      kinds.set(name, registry.kind(name));
    } catch (error) {
      // kind() throws only for a name no plugin registered
      const fix = "Use a challenge kind that core or a plugin defines, or add the plugin that defines this one.";
      issues.push(schemaIssue(configFile.path, lineAt(configFile, path), (error as Error).message, fix));
    }
  }
  return { kinds, issues };
}

function chainResolvers(config: ProjectConfig, registry: PluginRegistry): Map<string, ChallengeResolver> {
  const resolvers = new Map<string, ChallengeResolver>();
  for (const name of Object.values(config.envs).flatMap(({ challenges }) => Object.values(challenges).flat())) {
    if (resolvers.has(name)) continue;
    try {
      resolvers.set(name, registry.resolver(name));
    } catch {
      // resolver() throws only for a name no plugin registered, which the run refuses when it builds the chain
    }
  }
  return resolvers;
}

function runnerFormats(config: ProjectConfig, registry: PluginRegistry): Set<string> {
  const known = new Set<string>();
  for (const { format } of Object.values(config.runners)) {
    try {
      registry.resultFormat(format);
      known.add(format);
    } catch {
      // resultFormat() throws only for a name no plugin registered, which runner-format-known reports
    }
  }
  return known;
}

/** Reads each runner's mapping file once; a missing or invalid one is an issue under runner-mapping-valid. */
async function readMappings(
  root: string,
  config: ProjectConfig,
  configFile: ProjectFile,
): Promise<{ mappings: Map<string, RunnerMapping>; files: ProjectFile[]; issues: LoadIssue[] }> {
  const mappings = new Map<string, RunnerMapping>();
  const parsed = new Map<string, { file: ProjectFile; data: RunnerMapping | undefined }>();
  const issues: LoadIssue[] = [];
  for (const [name, { mapping }] of Object.entries(config.runners)) {
    if (mapping === undefined) continue;
    let entry = parsed.get(mapping);
    if (entry === undefined) {
      const file = await readProjectFile(root, mapping);
      if (file === undefined) {
        issues.push({
          ...schemaIssue(
            configFile.path,
            lineAt(configFile, ["runners", name, "mapping"]),
            `mapping file ${mapping} of runner ${name} is missing`,
            "Create the mapping file, or set mapping to its path relative to the project root.",
          ),
          ruleId: MAPPING_RULE,
        });
        continue;
      }
      const result = parseFile(file, MappingFile, "Give the mapping file a tests map of test titles to case ids.");
      issues.push(...result.issues.map((issue) => ({ ...issue, ruleId: MAPPING_RULE })));
      entry = { file, data: result.data };
      parsed.set(mapping, entry);
    }
    if (entry.data !== undefined) mappings.set(name, entry.data);
  }
  return { mappings, files: [...parsed.values()].map(({ file }) => file), issues };
}

/**
 * Asks git which state folders a `.gitignore` ignores, so a project in a subfolder of a repository counts
 * the parent's patterns. Undefined when git is missing or the root is in no repository.
 */
async function gitIgnoredStateDirs(root: string): Promise<Set<string> | undefined> {
  let stdout: string;
  try {
    ({ stdout } = await execFileAsync(
      "git",
      ["check-ignore", "--no-index", "--verbose", ...STATE_DIRS.map((dir) => `${dir}/`)],
      { cwd: root, env: await gitEnvForCwd() },
    ));
  } catch (error) {
    // exit code 1: git ignores none of them
    if ((error as { code?: unknown }).code !== 1) return undefined;
    stdout = "";
  }
  const ignored = new Set<string>();
  for (const line of stdout.split("\n")) {
    // <source>:<line>:<pattern><tab><path>
    const [, source = "", pattern = "", path = ""] = /^(.*?):\d+:(.*)\t(.*)$/.exec(line) ?? [];
    // .git/info/exclude and the user's global excludes file never reach teammates
    if (posix.basename(source) === ".gitignore" && !pattern.startsWith("!")) ignored.add(path.replace(/\/$/, ""));
  }
  return ignored;
}

/**
 * This process's environment without git's repository variables, such as the GIT_DIR a git hook exports
 * in a linked worktree, which would make git ignore the working directory and read another repository.
 */
async function gitEnvForCwd(): Promise<NodeJS.ProcessEnv> {
  const { stdout } = await execFileAsync("git", ["rev-parse", "--local-env-vars"]);
  const env = { ...process.env };
  for (const name of stdout.split("\n")) if (name !== "") delete env[name];
  return env;
}

// "/runs/", "**/runs" and "runs/*" all name the runs folder
function rootIgnoredStateDirs(gitignore: string): Set<string> {
  const dirs = gitignore.split(/\r?\n/).map((line) =>
    line
      .trim()
      .replace(/^(?:\*\*)?\//, "")
      .replace(/\/\**$/, ""),
  );
  return new Set(STATE_DIRS.filter((dir) => dirs.includes(dir)));
}

function parseFile<S extends z.ZodType>(
  file: ProjectFile,
  schema: S,
  fix: string,
): { data: z.output<S> | undefined; issues: LoadIssue[] } {
  if (file.doc.errors.length > 0) return { data: undefined, issues: syntaxIssues(file) };
  // a file with only comments parses to null
  const result = schema.safeParse(file.doc.toJS() ?? {});
  if (result.success) return { data: result.data, issues: [] };
  return { data: undefined, issues: result.error.issues.map((issue) => zodIssue(file, issue, fix)) };
}

function syntaxIssues(file: ProjectFile): LoadIssue[] {
  return file.doc.errors.map((error) =>
    schemaIssue(file.path, file.lines.linePos(error.pos[0]).line, error.message, SYNTAX_FIX),
  );
}

function zodIssue(file: ProjectFile, issue: z.core.$ZodIssue, fix: string): LoadIssue {
  const path = issue.code === "unrecognized_keys" ? [...issue.path, ...issue.keys.slice(0, 1)] : issue.path;
  const where = issue.path
    .map((segment, index) =>
      typeof segment === "number" ? `[${segment}]` : `${index === 0 ? "" : "."}${String(segment)}`,
    )
    .join("");
  return schemaIssue(file.path, lineAt(file, path), where === "" ? issue.message : `${where}: ${issue.message}`, fix);
}

function schemaIssue(file: string, line: number, message: string, fix: string): LoadIssue {
  return { ruleId: "schema", severity: "error", file, line, message, fix };
}

async function readAll(root: string, paths: readonly string[]): Promise<ProjectFile[]> {
  const files: ProjectFile[] = [];
  for (const path of paths) {
    const file = await readProjectFile(root, path);
    if (file !== undefined) files.push(file);
  }
  return files;
}

async function readProjectFile(root: string, path: string): Promise<ProjectFile | undefined> {
  const text = await readText(join(root, path));
  if (text === undefined) return undefined;
  const lines = new LineCounter();
  return { path, text, doc: parseDocument(text, { lineCounter: lines, prettyErrors: false }), lines };
}

async function readText(path: string): Promise<string | undefined> {
  try {
    return await readFile(path, "utf8");
  } catch (error) {
    if (isNotFound(error)) return undefined;
    throw error;
  }
}

async function readDir(path: string) {
  try {
    return await readdir(path, { withFileTypes: true });
  } catch (error) {
    if (isNotFound(error)) return [];
    throw error;
  }
}

function startOf(node: unknown): number | undefined {
  return isNode(node) ? node.range?.[0] : undefined;
}

function isNotFound(error: unknown): boolean {
  return (error as NodeJS.ErrnoException).code === "ENOENT";
}
