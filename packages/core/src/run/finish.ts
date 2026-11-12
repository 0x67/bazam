import { AsyncLocalStorage } from "node:async_hooks";
import { appendFile, mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { LoadedCase } from "../case/index.ts";
import type { Environment } from "../env/index.ts";
import type { UnmappedTest } from "../ingest/index.ts";
import type { PluginRegistry } from "../plugin/index.ts";
import { resultLineOf, type Project } from "../project.ts";
import type { Redactor } from "../redact/index.ts";
import { buildPostPlans, loadReceipts, PeopleRegistry } from "../report/index.ts";
import { loadScanValues, withheldAttachments } from "../scan/index.ts";
import {
  writeRunStatus,
  writeRunSummary,
  type CaseResult,
  type RunProgress,
} from "../result/index.ts";

export interface FinishDeps {
  runId: string;
  project: Project;
  env: Environment;
  cases: readonly LoadedCase[];
  registry: PluginRegistry;
  redactor: Redactor;
  /** `<root>/<stateDir>` */
  stateDir: string;
  progress: ProgressFile;
  log: RunLog;
}

/**
 * Writes summary.json, summary.md and post-plan.json in the order of `results`, sets status.json to finished and
 * flushes the run log. Masks each unmapped test, whose title and reason come from a runner's report.
 */
export async function finishRun(
  runDir: string,
  results: readonly CaseResult[],
  unmapped: readonly UnmappedTest[],
  deps: FinishDeps,
): Promise<void> {
  const { project, registry, env, cases, redactor } = deps;
  const masked = unmapped.map((test) => ({
    ...test,
    title: redactor.text(test.title),
    reason: redactor.text(test.reason),
  }));
  await writeRunSummary(runDir, results, masked);
  const withheld = await withheldFrom(runDir, results, deps);
  const postPlan = buildPostPlans({
    runId: deps.runId,
    env: env.name,
    results,
    specs: new Map(cases.map(({ spec }) => [spec.id, spec])),
    people: await PeopleRegistry.load(project.root),
    receipts: await loadReceipts(deps.stateDir),
    trackers: (name) => registry.tracker(name),
    transitions: project.config.trackers,
    resultLine: (name) => resultLineOf(project.config, name),
    ...(withheld === undefined ? {} : { withheld }),
    now: new Date(),
  });
  // only the comments go through the redactor again: its digit rule would break account ids and receipt URLs
  const plan = {
    ...postPlan,
    items: postPlan.items.map((item) => ({ ...item, comment: redactor.value(item.comment) })),
  };
  await writeFile(join(runDir, "post-plan.json"), `${JSON.stringify(plan, null, 2)}\n`);
  await deps.progress.update((progress) => {
    progress.state = "finished";
  });
  await deps.log.flush(join(runDir, "run.log"));
}

// a scan that fails leaves the plan without withheld attachments and never changes the run's outcome
async function withheldFrom(
  runDir: string,
  results: readonly CaseResult[],
  deps: FinishDeps,
): Promise<ReadonlyMap<string, readonly string[]> | undefined> {
  try {
    const { project, registry, env, redactor } = deps;
    const [first] = results;
    const around = first === undefined ? new Date() : new Date(first.startedAt);
    const values = await loadScanValues({ project, registry, env, redactor, around });
    const withheld = await withheldAttachments(runDir, results, values);
    for (const [attachment, kinds] of withheld)
      deps.log.line(`post plan withholds ${attachment}: ${kinds.join(", ")}`);
    return withheld;
  } catch (error) {
    deps.log.line(`scanning the attachments failed: ${(error as Error).message}`);
    return undefined;
  }
}

/**
 * Collects log lines and appends them, masked, to the run log or a case log. A line goes to the buffer of the
 * `apart` call whose async context logs it, else to the run's.
 */
export class RunLog {
  readonly #redactor: Redactor;
  readonly #runLines: string[] = [];
  readonly #caseLines = new AsyncLocalStorage<string[]>();

  constructor(redactor: Redactor) {
    this.#redactor = redactor;
  }

  readonly line = (text: string): void => {
    this.#lines().push(text);
  };

  /** Runs `fn` with a buffer of its own, which `flush` inside it writes. */
  apart<T>(fn: () => Promise<T>): Promise<T> {
    return this.#caseLines.run([], fn);
  }

  /** Writes the current buffer. Masks at write time, so a secret registered after its line was logged is masked too. */
  async flush(file: string): Promise<void> {
    const lines = this.#lines().splice(0);
    if (lines.length === 0) return;
    const text = this.#redactor.text(`${lines.join("\n")}\n`);
    await mkdir(dirname(file), { recursive: true });
    await appendFile(file, text);
  }

  #lines(): string[] {
    return this.#caseLines.getStore() ?? this.#runLines;
  }
}

/** The run's progress and its status.json, rewritten after each change. */
export class ProgressFile {
  readonly #runDir: string;
  readonly #progress: RunProgress;
  #writing: Promise<void> = Promise.resolve();

  constructor(runDir: string, runId: string) {
    this.#runDir = runDir;
    this.#progress = { runId, state: "running", total: 0, pendingPrompts: 0, results: [] };
  }

  /** Writes one at a time, since a prompt can end while the runner writes after a case. */
  update(change: (progress: RunProgress) => void): Promise<void> {
    change(this.#progress);
    const snapshot = structuredClone(this.#progress);
    const write = this.#writing.then(() => writeRunStatus(this.#runDir, snapshot));
    // the caller of a failed write gets its error; the next write still goes ahead
    this.#writing = write.catch(() => undefined);
    return write;
  }
}

/** The fields of a result that status.json lists. */
export function progressEntry(result: CaseResult): RunProgress["results"][number] {
  return {
    caseId: result.caseId,
    status: result.status,
    ...(result.reason === undefined ? {} : { reason: result.reason }),
  };
}
