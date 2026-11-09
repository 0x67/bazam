import { readFile, realpath, stat } from "node:fs/promises";
import { dirname, extname, isAbsolute, join, relative, resolve, sep } from "node:path";
import type { CaseSpec } from "../case/index.ts";
import type { Redactor } from "../redact/index.ts";
import { EvidenceStore, type CaseMeta, type CaseOutcome, type CaseResult } from "../result/index.ts";
import type { ExternalTest } from "./format.ts";
import { testTitle, type MappedTests } from "./mapping.ts";

const MAX_ATTACHMENT_BYTES = 20 * 1024 * 1024;
// file systems with coarse timestamps can date a file up to 2 s before the spawn
const MTIME_SLACK_MS = 2000;
const ATTACHMENT_TYPES: Readonly<Record<string, "png" | "txt" | "json">> = {
  ".png": "png",
  ".txt": "txt",
  ".log": "txt",
  ".json": "json",
};

export interface ExternalRecordInputs {
  runDir: string;
  runId: string;
  envName: string;
  target: string;
  runnerName: string;
  /** Attachments must resolve inside it. */
  runnerCwd: string;
  root: string;
  /** Attachments must resolve outside it and outside `<root>/runs`. */
  stateDir: string;
  /** Set in a run, absent in ingest. */
  spawnedAt?: Date;
  /** The selected cases of this target, in plan order. */
  cases: readonly CaseSpec[];
  tests: MappedTests["byCase"];
  /** Why the suite ended early or gave no results; blocks every case that has no test. */
  failure?: string;
  /** Requests the run's challenge service answered, by case id; empty in ingest. */
  challenges: ReadonlyMap<string, CaseResult["challenges"]>;
  seed: number;
  startedAt: Date;
  finishedAt: Date;
  redactor: Redactor;
}

/** Writes one result per selected case from its mapped tests, copying the attachments a runner may have written. */
export async function recordExternalResults(inputs: ExternalRecordInputs): Promise<CaseResult[]> {
  const places = await attachmentPlaces(inputs);
  const results: CaseResult[] = [];
  for (const spec of inputs.cases) {
    const tests = inputs.tests.get(spec.id) ?? [];
    const store = new EvidenceStore(inputs.runDir, spec.id, inputs.redactor);
    for (const test of tests) {
      if (test.outcome !== "skipped") {
        store.record({
          name: testTitle(test),
          kind: "external",
          expected: "passed",
          observed: observed(test),
          ok: test.outcome === "passed",
          ...(test.message === undefined ? {} : { hint: test.message }),
        });
      }
      for (const attachment of test.attachments) await copyAttachment(store, test, attachment, places, inputs);
    }
    for (const { step, kind, resolver } of inputs.challenges.get(spec.id) ?? []) store.challenge(step, kind, resolver);
    const meta: CaseMeta = {
      runId: inputs.runId,
      title: spec.title,
      stage: spec.stage,
      env: inputs.envName,
      target: inputs.target,
      links: spec.links,
      identities: [],
      seed: inputs.seed,
      values: {},
      startedAt: inputs.startedAt,
    };
    results.push(await store.finish(outcomeOf(spec.id, tests, inputs), meta, inputs.finishedAt));
  }
  return results;
}

function observed(test: ExternalTest): string {
  if (test.outcome !== "passed" || test.retries === 0) return test.outcome;
  return `passed after ${test.retries} ${test.retries === 1 ? "retry" : "retries"}`;
}

function outcomeOf(caseId: string, tests: readonly ExternalTest[], inputs: ExternalRecordInputs): CaseOutcome {
  if (tests.length === 0) {
    return { kind: "blocked", reason: inputs.failure ?? `no result from runner ${inputs.runnerName} for ${caseId}` };
  }
  // a failed check outranks the skipped tests, so deriveStatus gives fail
  if (tests.some((test) => test.outcome === "failed" || test.outcome === "errored")) return { kind: "completed" };
  const skipped = tests.filter((test) => test.outcome === "skipped").map(testTitle);
  if (skipped.length > 0) return { kind: "blocked", reason: `skipped: ${skipped.join(", ")}` };
  return { kind: "completed" };
}

interface AttachmentPlaces {
  cwd: string;
  excluded: readonly string[];
}

// a file's realpath is compared with these folders, so they are realpaths too; a missing one is only made absolute
async function attachmentPlaces(inputs: ExternalRecordInputs): Promise<AttachmentPlaces> {
  const real = (path: string) => realpath(path).catch(() => resolve(path));
  return {
    cwd: await real(inputs.runnerCwd),
    excluded: [await real(inputs.stateDir), await real(join(inputs.root, "runs"))],
  };
}

async function copyAttachment(
  store: EvidenceStore,
  test: ExternalTest,
  { name, path }: ExternalTest["attachments"][number],
  places: AttachmentPlaces,
  inputs: ExternalRecordInputs,
): Promise<void> {
  const ext = extname(path).toLowerCase();
  const type = ATTACHMENT_TYPES[ext];
  if (type === undefined) {
    store.note(`left out ${name}: ${ext.slice(1) || "extensionless"} files from a runner are not copied`);
    return;
  }
  const file = await findFile(path, test.source, places.cwd);
  if (file === undefined) {
    store.note(`attachment ${name} was not found`);
    return;
  }
  const { size, mtimeMs } = await stat(file);
  const tooOld = inputs.spawnedAt !== undefined && mtimeMs < inputs.spawnedAt.getTime() - MTIME_SLACK_MS;
  if (!isInside(places.cwd, file) || places.excluded.some((dir) => isInside(dir, file)) || tooOld) {
    store.note(`left out ${name}: not a file this runner wrote`);
    return;
  }
  if (size > MAX_ATTACHMENT_BYTES) {
    store.note(`left out ${name}: larger than 20 MiB`);
    return;
  }
  try {
    await store.attach(name, await readFile(file), type);
  } catch (error) {
    // the store parses JSON to mask it, and one bad file must not end the case
    if (!(error instanceof SyntaxError)) throw error;
    store.note(`left out ${name}: not valid JSON`);
  }
}

/** The realpath of the first regular file the path names, from the result file's folder and then from the cwd. */
async function findFile(path: string, source: string, cwd: string): Promise<string | undefined> {
  const candidates = isAbsolute(path) ? [path] : [resolve(cwd, dirname(source), path), resolve(cwd, path)];
  for (const candidate of candidates) {
    const file = await realpath(candidate).catch(() => undefined);
    if (file !== undefined && (await stat(file)).isFile()) return file;
  }
  return undefined;
}

function isInside(dir: string, file: string): boolean {
  const path = relative(dir, file);
  return path !== ".." && !path.startsWith(`..${sep}`) && !isAbsolute(path);
}
