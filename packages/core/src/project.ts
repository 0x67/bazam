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
  type FlowSpec,
  type LoadedCase,
  type LoadIssue,
  type SourceSpan,
  type Step,
} from "./case/index.ts";
import type { ChallengeKindSpec, ChallengeResolver } from "./challenge/index.ts";
import { EnvsConfig } from "./env/index.ts";
import type { PluginRegistry } from "./plugin/index.ts";
import { RedactionConfig } from "./redact/index.ts";

const SUITES_FILE = "suites.yaml";
const SYNTAX_FIX = "Fix the YAML syntax on this line.";
const execFileAsync = promisify(execFile);

/** Folders that stay out of git: run results and local state such as cached credentials. */
export const STATE_DIRS: readonly string[] = ["runs", BRAND.stateDir];

const TrackerConfig = z.strictObject({
  projects: z
    .record(
      z.string().min(1),
      z.strictObject({
        transitions: z.partialRecord(z.enum(["pass", "fail", "blocked", "followup"]), z.string().min(1)),
      }),
    )
    .default({}),
});

/** The project config file. */
export const ProjectConfig = z.strictObject({
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
  /** Per case target: `driver` names its driver, which gets the other settings, such as browser and headless. */
  targets: z.record(z.string().min(1), z.object({ driver: z.string().min(1) }).catchall(z.json())).default({}),
  /** Default transitions per tracker project. */
  trackers: z.record(z.string().min(1), TrackerConfig).default({}),
  plugins: z.array(z.string().min(1)).default([]),
  /** Patterns and screenshot selectors masked on top of the built-in rules. */
  redaction: RedactionConfig.prefault({}),
});
export type ProjectConfig = z.infer<typeof ProjectConfig>;

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
  const files = [configFile, ...caseFiles, ...flows.files, suites.file, fixtures.file].filter(
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
    files: new Map(files.map((file) => [file.path, file])),
    ignoredStateDirs:
      (await gitIgnoredStateDirs(root)) ?? rootIgnoredStateDirs((await readText(join(root, ".gitignore"))) ?? ""),
    issues: [...caseLoad.issues, ...flows.issues, ...suites.issues, ...fixtures.issues, ...kinds.issues],
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
      { cwd: root },
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
