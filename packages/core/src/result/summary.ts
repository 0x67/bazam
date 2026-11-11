import { mkdir, rename, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import type { UnmappedTest } from "../ingest/mapping.ts";
import type { CaseResult } from "./evidence.ts";
import type { Status } from "./status.ts";

/** `YYYYMMDD-HHmmss-<4 hex>` from the UTC clock; `random` returns a number in [0, 1) like `Math.random`. */
export function newRunId(now: Date, random: () => number): string {
  const stamp = now.toISOString().slice(0, 19).replace(/[-:]/g, "").replace("T", "-");
  const suffix = Math.floor(random() * 0x10000)
    .toString(16)
    .padStart(4, "0");
  return `${stamp}-${suffix}`;
}

/** Progress of a run, read from status.json by the MCP run supervisor. */
export interface RunProgress {
  runId: string;
  state: "running" | "finished";
  total: number;
  pendingPrompts: number;
  results: Pick<CaseResult, "caseId" | "status" | "reason">[];
}

export async function writeRunStatus(runDir: string, progress: RunProgress): Promise<void> {
  const file = join(runDir, "status.json");
  await mkdir(runDir, { recursive: true });
  // another process reads the file while the runner rewrites it, so it must never see half a file
  await writeFile(`${file}.tmp`, toJson(progress));
  await rename(`${file}.tmp`, file);
}

/**
 * Writes summary.json and summary.md from the results `EvidenceStore.finish` returned, which are already masked.
 * The caller masks `unmapped`; with none, neither file mentions it.
 */
export async function writeRunSummary(
  runDir: string,
  results: readonly CaseResult[],
  unmapped: readonly UnmappedTest[] = [],
): Promise<void> {
  const runId = basename(runDir);
  const count = (status: Status) => results.filter((result) => result.status === status).length;
  const counts = {
    pass: count("pass"),
    fail: count("fail"),
    blocked: count("blocked"),
    followup: count("followup"),
    total: results.length,
  };
  const cases = results.map(({ caseId, title, target, status, reason }) => ({
    caseId,
    title,
    target,
    status,
    ...(reason === undefined ? {} : { reason }),
  }));
  await mkdir(runDir, { recursive: true });
  await writeFile(
    join(runDir, "summary.json"),
    toJson({ runId, counts, cases, ...(unmapped.length === 0 ? {} : { unmapped }) }),
  );
  await writeFile(join(runDir, "summary.md"), summaryMarkdown(runId, results, counts, unmapped));
}

function summaryMarkdown(
  runId: string,
  results: readonly CaseResult[],
  counts: Record<Status | "total", number>,
  unmapped: readonly UnmappedTest[],
): string {
  const followups = results.flatMap((result) =>
    result.followups.map((f) => row([result.caseId, f.item, f.hint])),
  );
  return [
    `# Run ${runId}`,
    "",
    `${counts.pass} pass, ${counts.fail} fail, ${counts.blocked} blocked, ${counts.followup} followup, ${counts.total} total.`,
    "",
    "| Case | Title | Target | Status | Reason or failed checks |",
    "| --- | --- | --- | --- | --- |",
    ...results.map((result) =>
      row([result.caseId, result.title, result.target, result.status, detail(result)]),
    ),
    "",
    "## Follow-up",
    "",
    ...(followups.length === 0
      ? ["None."]
      : ["| Case | Item | Hint |", "| --- | --- | --- |", ...followups]),
    "",
    ...(unmapped.length === 0
      ? []
      : [
          "## Unmapped tests",
          "",
          "| Target | Test | Reason |",
          "| --- | --- | --- |",
          ...unmapped.map((test) => row([test.target, test.title, test.reason])),
          "",
        ]),
  ].join("\n");
}

function detail(result: CaseResult): string {
  if (result.reason !== undefined) return result.reason;
  const failed = result.checks.filter((check) => !check.ok).map((check) => check.name);
  return failed.length === 0 ? "" : `failed: ${failed.join(", ")}`;
}

// a pipe or line break inside a cell would end the table row
function row(cells: readonly string[]): string {
  return `| ${cells.map((cell) => cell.replaceAll("|", "\\|").replace(/\s*\n\s*/g, " ")).join(" | ")} |`;
}

function toJson(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}
