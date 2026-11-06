import { appendFile, readdir, readFile, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { isMap, isScalar, isSeq, parseDocument, type CST, type YAMLMap, type YAMLSeq } from "yaml";
import type { z } from "zod";
import type { CaseResult, Status } from "../result/index.ts";
import type { LoadedCase } from "./load.ts";
import { Stage as StageSchema, type CaseSpec } from "./schema.ts";

// the same enum as schema.ts, so `Stage` names the schema and its type together
export const Stage = StageSchema;
export type Stage = z.infer<typeof Stage>;

export interface StagePolicyRule {
  runs: boolean;
  /** Statuses that produce a post plan item on the case's linked tickets. */
  postsOn: readonly Status[];
}

const policies: Record<Stage, StagePolicyRule> = {
  draft: { runs: true, postsOn: [] },
  acceptance: { runs: true, postsOn: ["pass", "fail", "blocked", "followup"] },
  regression: { runs: true, postsOn: ["fail", "blocked"] },
  retired: { runs: false, postsOn: [] },
};

export function stagePolicy(stage: Stage): StagePolicyRule {
  return policies[stage];
}

export type PromoteDecision = { ok: true } | { ok: false; reason: string };

/** `latest` is the newest result of the case in the environment it is promoted for. */
export function canPromote(spec: CaseSpec, latest: CaseResult | undefined): PromoteDecision {
  if (spec.once) return { ok: false, reason: `${spec.id} has once: true; a once case is never promoted` };
  if (spec.stage !== "acceptance") {
    return { ok: false, reason: `${spec.id} is in stage ${spec.stage}; only acceptance cases are promoted` };
  }
  if (latest === undefined) return { ok: false, reason: `${spec.id} has no result in this environment` };
  if (latest.status !== "pass") {
    return { ok: false, reason: `the latest result of ${spec.id} in ${latest.env} is ${latest.status}, from run ${latest.runId}` };
  }
  return { ok: true };
}

/** Moves the case to `regression` when its latest result in `env` passed, editing only the stage value in its file. */
export async function promoteCase(root: string, target: LoadedCase, env: string): Promise<PromoteDecision> {
  const decision = canPromote(target.spec, await latestResult(root, target.spec.id, env));
  if (!decision.ok) return decision;
  const file = join(root, target.source.file);
  const text = await readFile(file, "utf8");
  const stage = findCase(text, target).item.get("stage", true);
  if (!isScalar(stage) || !stage.range) throw new Error(`${target.spec.id} in ${target.source.file} has no stage value`);
  // splice the source text: printing the document again would restyle flow collections across the file
  await writeFile(file, text.slice(0, stage.range[0]) + "regression" + text.slice(stage.range[1]));
  return decision;
}

/** Removes the case from its file, deletes the file when no case is left, and appends the id to `cases/.retired`. */
export async function retireCase(root: string, target: LoadedCase): Promise<void> {
  const file = join(root, target.source.file);
  const text = await readFile(file, "utf8");
  const { cases, item } = findCase(text, target);
  const edited = cases.items.length === 1 ? undefined : withoutItem(text, cases, item);
  // an id left in a file and in .retired fails check, but a removed id missing from .retired could be reused
  await appendRetiredId(root, target.spec.id);
  if (edited === undefined) await unlink(file);
  else await writeFile(file, edited);
}

async function latestResult(root: string, caseId: string, env: string): Promise<CaseResult | undefined> {
  let runs;
  try {
    runs = await readdir(join(root, "runs"), { withFileTypes: true });
  } catch (error) {
    if (isNotFound(error)) return undefined;
    throw error;
  }
  let latest: CaseResult | undefined;
  for (const run of runs.filter((entry) => entry.isDirectory())) {
    let text: string;
    try {
      text = await readFile(join(root, "runs", run.name, caseId, "result.json"), "utf8");
    } catch (error) {
      if (isNotFound(error)) continue;
      throw error;
    }
    const result = JSON.parse(text) as CaseResult;
    if (result.env !== env) continue;
    if (latest === undefined || Date.parse(result.finishedAt) > Date.parse(latest.finishedAt)) latest = result;
  }
  return latest;
}

function findCase(text: string, target: LoadedCase): { cases: YAMLSeq; item: YAMLMap } {
  const doc = parseDocument(text, { keepSourceTokens: true });
  const cases = doc.get("cases", true);
  const item = isSeq(cases) ? cases.items.find((entry) => isMap(entry) && entry.get("id") === target.spec.id) : undefined;
  if (!isSeq(cases) || !isMap(item)) throw new Error(`${target.spec.id} is not in ${target.source.file}`);
  return { cases, item };
}

/**
 * Cuts the item's lines out of the source text, starting at the comment lines the parser gives to it.
 * The cut ends where the next item's lines start, so blank lines and comments before that item stay.
 */
function withoutItem(text: string, cases: YAMLSeq, item: YAMLMap): string {
  const token = cases.srcToken;
  if (token?.type !== "block-seq") throw new Error("retire needs `cases` written as a block list, one `- ` per case");
  const at = token.items.findIndex((entry) => entry.value === item.srcToken);
  const lineStart = (offset: number) => text.lastIndexOf("\n", offset - 1) + 1;
  // a comment after the last item is an entry of its own, with no value
  const firstLine = (start: readonly CST.SourceToken[] | undefined) => {
    const first = start?.find((t) => t.type === "comment" || t.type === "seq-item-ind");
    return first === undefined ? undefined : lineStart(first.offset);
  };
  const start = firstLine(token.items[at]?.start);
  if (start === undefined || !item.range) throw new Error("a case item has no `- ` indicator");
  const end = firstLine(token.items[at + 1]?.start) ?? lineEndAfter(text, item.range[1]);
  return text.slice(0, start) + text.slice(end);
}

function lineEndAfter(text: string, offset: number): number {
  if (text[offset - 1] === "\n") return offset;
  const newline = text.indexOf("\n", offset);
  return newline === -1 ? text.length : newline + 1;
}

async function appendRetiredId(root: string, id: string): Promise<void> {
  const file = join(root, "cases", ".retired");
  let current = "";
  try {
    current = await readFile(file, "utf8");
  } catch (error) {
    if (!isNotFound(error)) throw error;
  }
  const separator = current === "" || current.endsWith("\n") ? "" : "\n";
  await appendFile(file, `${separator}${id}\n`);
}

function isNotFound(error: unknown): boolean {
  return (error as NodeJS.ErrnoException).code === "ENOENT";
}
