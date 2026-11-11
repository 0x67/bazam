import { readFile } from "node:fs/promises";
import { basename, join, relative, resolve } from "node:path";
import { BRAND } from "../brand.ts";
import type { CaseSpec, LoadedCase } from "../case/index.ts";
import type { Environment } from "../env/index.ts";
import {
  mapTests,
  recordExternalResults,
  ResultParseError,
  type ExternalTest,
  type UnmappedTest,
} from "../ingest/index.ts";
import type { PluginRegistry } from "../plugin/index.ts";
import { declaredSecretNames, runnerOf, type Project } from "../project.ts";
import type { Redactor } from "../redact/index.ts";
import type { CaseResult } from "../result/index.ts";
import { finishRun, ProgressFile, progressEntry, RunLog } from "./finish.ts";
import { messageOf } from "./outcome.ts";
import { planRun } from "./plan.ts";

export interface IngestOptions {
  project: Project;
  env: Environment;
  registry: PluginRegistry;
  /** A runner target; its runner gives the format, the mapping and the cwd attachments resolve against. */
  target: string;
  /** The selection, narrowed to cases that run on the target. */
  cases: readonly LoadedCase[];
  /** Absolute paths. */
  files: readonly string[];
  runDir: string;
  redactor: Redactor;
  seed: number;
}

/**
 * Records the target's cases from result files written elsewhere, as a run of those cases would, and starts no
 * process. Registers the inherited values of the declared secrets with the redactor first, as `Run.startService`
 * does, since the runner that wrote the files had them in its environment. Throws before writing anything when a
 * file cannot be read or the target names no runner.
 */
export async function ingestResults(options: IngestOptions): Promise<CaseResult[]> {
  const { project, env, registry, target, cases, runDir, redactor, seed } = options;
  for (const name of declaredSecretNames(project.config)) {
    const value = process.env[name];
    if (value !== undefined && value !== "") redactor.register(value);
  }
  const external = runnerOf(project.config, target);
  if (external === undefined) throw new Error(`target ${target} does not name a runner`);
  const cwd = resolve(project.root, external.runner.cwd);
  const files = await Promise.all(
    options.files.map(async (file) => {
      const text = await readFile(file, "utf8");
      return { path: relative(cwd, file), read: () => Promise.resolve(text) };
    }),
  );
  // ingest starts no process, so a production run needs no yes
  const plan = planRun({
    project,
    env,
    cases,
    registry,
    targets: [target],
    capabilities: new Map(),
    credentials: new Map(),
  });
  const runId = basename(runDir);
  const log = new RunLog(redactor);
  const startedAt = new Date();
  const record = {
    project,
    registry,
    redactor,
    log: log.line,
    target,
    runDir,
    runId,
    envName: env.name,
    seed,
  };
  const open = cases
    .filter((_, index) => plan.cases[index]?.blocked === undefined)
    .map(({ spec }) => spec);
  const suite =
    open.length === 0
      ? { results: [], unmapped: [] }
      : await recordSuite({ ...record, cases: open, files, challenges: new Map(), startedAt });
  const results: CaseResult[] = [];
  for (const [index, { spec }] of cases.entries()) {
    const reason = plan.cases[index]?.blocked;
    const result =
      reason === undefined
        ? suite.results.find((recorded) => recorded.caseId === spec.id)
        : (
            await recordSuite({
              ...record,
              cases: [spec],
              files: [],
              failure: reason,
              challenges: new Map(),
              startedAt,
            })
          ).results[0];
    if (result !== undefined) results.push(result);
  }
  const progress = new ProgressFile(runDir, runId);
  await progress.update((status) => {
    status.total = cases.length;
    status.results = results.map(progressEntry);
  });
  const stateDir = join(project.root, BRAND.stateDir);
  await finishRun(runDir, results, suite.unmapped, {
    runId,
    project,
    env,
    cases,
    registry,
    redactor,
    stateDir,
    progress,
    log,
  });
  return results;
}

/** What the cases of one runner target are recorded from. */
export interface SuiteRecord {
  project: Project;
  registry: PluginRegistry;
  redactor: Redactor;
  log: (line: string) => void;
  target: string;
  runDir: string;
  runId: string;
  envName: string;
  seed: number;
  /** The selected cases of the target, in plan order. */
  cases: readonly CaseSpec[];
  /** Result files with paths relative to the runner's cwd. */
  files: readonly { path: string; read(): Promise<string> }[];
  /** Why the suite ended early or gave no results. */
  failure?: string;
  spawnedAt?: Date;
  challenges: ReadonlyMap<string, CaseResult["challenges"]>;
  startedAt: Date;
}

/**
 * Parses the files with the runner's format, maps their tests to cases and writes one result per case. A file
 * that does not parse is logged; when none parses, the cases without tests are blocked with the first error.
 */
export async function recordSuite(
  record: SuiteRecord,
): Promise<{ results: CaseResult[]; unmapped: UnmappedTest[] }> {
  const { project, target } = record;
  // the run builds a suite only from cases the plan gave a runner, and ingestResults checks its target first
  const { name, runner } = runnerOf(project.config, target)!;
  const tests: ExternalTest[] = [];
  const errors: string[] = [];
  for (const file of record.files) {
    try {
      const format = record.registry.resultFormat(runner.format);
      tests.push(...(await format.parse({ path: file.path, text: await file.read() })));
    } catch (error) {
      // a process plugin's format can fail in ways of its own, such as by exiting
      errors.push(
        error instanceof ResultParseError ? error.message : `${file.path}: ${messageOf(error)}`,
      );
      record.log(`[${target}] ${errors.at(-1)}`);
    }
  }
  const allFailed = record.files.length > 0 && errors.length === record.files.length;
  const failure = record.failure ?? (allFailed ? errors[0] : undefined);
  const mapping = project.mappings.get(name);
  const mapped = mapTests({
    target,
    tests,
    cases: new Map(project.cases.map(({ spec }) => [spec.id, spec])),
    selected: new Set(record.cases.map((spec) => spec.id)),
    ...(mapping === undefined ? {} : { mapping }),
  });
  const outside = mapped.outsideSelection;
  if (outside > 0)
    record.log(
      `[${target}] ${outside} ${outside === 1 ? "test belongs to a case" : "tests belong to cases"} this run did not select`,
    );
  const results = await recordExternalResults({
    runDir: record.runDir,
    runId: record.runId,
    envName: record.envName,
    target,
    runnerName: name,
    runnerCwd: resolve(project.root, runner.cwd),
    root: project.root,
    stateDir: join(project.root, BRAND.stateDir),
    ...(record.spawnedAt === undefined ? {} : { spawnedAt: record.spawnedAt }),
    cases: record.cases,
    tests: mapped.byCase,
    ...(failure === undefined ? {} : { failure }),
    challenges: record.challenges,
    seed: record.seed,
    startedAt: record.startedAt,
    finishedAt: new Date(),
    redactor: record.redactor,
  });
  return { results, unmapped: mapped.unmapped };
}
