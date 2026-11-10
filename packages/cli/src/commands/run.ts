import { constants, existsSync } from "node:fs";
import { copyFile, mkdir, readdir } from "node:fs/promises";
import { basename, join, relative, resolve } from "node:path";
import { newRunId, type CaseResult } from "@bazam/core/result";
import { runCases } from "@bazam/core/run";
import { CommandError, exitCodeFor, ExitCode } from "../exit.ts";
import { plural } from "../io.ts";
import type { CommandContext } from "../main.ts";
import { PLAIN_NAME, planCommand, runDirOf, runOptions, startRun } from "./plan.ts";

const ANSWERS_CHANNEL = "answers-file";
// the run gives a production confirmation a random id, so a file named for one can never answer it
const CONFIRMATION = /^preflight-.*-confirm/;
const MAX_WORKERS = 16;

/** Runs the selected cases; exits 0, 1 or 3 by their statuses, and 2 when the run cannot start. */
export async function runCommand(ctx: CommandContext): Promise<ExitCode> {
  const { flags } = ctx;
  // only --answers copies answers in, so a real project never answers person steps from fixtures by accident
  if (flags.answers !== undefined && flags.channel !== ANSWERS_CHANNEL) {
    throw new CommandError(`--answers works only with --channel ${ANSWERS_CHANNEL}, which reads the copied answers`);
  }
  // read before a dry run returns, so it refuses the folder the run would refuse
  const answers = flags.answers === undefined ? undefined : await answerFiles(ctx, resolve(ctx.io.cwd, flags.answers));
  const workers = workersOf(flags.workers);
  if (flags["dry-run"] === true) return planCommand(ctx);
  const start = await startRun(ctx);
  const startedAt = new Date();
  const runId = flags.run ?? newRunId(startedAt, Math.random);
  const runDir = newRunDir(start.project.root, runId);
  if (answers !== undefined) await copyAnswers(answers, join(runDir, "answers"));
  ctx.out.log(`run ${runId}: ${plural(start.cases.length, "case")} on env ${start.env.name}, seed ${start.seed}`);
  const results = await runCases({ ...runOptions(ctx, start, runId, startedAt), workers });
  ctx.out.result(summary(runId, results), summaryText(runId, results, relative(ctx.io.cwd, runDir)));
  return exitCodeFor(results.map((result) => result.status));
}

/** The run's folder, refusing one whose run has started. */
export function newRunDir(root: string, runId: string): string {
  const runDir = runDirOf(root, runId);
  // a caller that picks the id, such as the MCP supervisor, may have put files in the folder; a started run has status.json
  if (existsSync(join(runDir, "status.json"))) {
    throw new CommandError(`run ${runId} has already started; pick another --run id`);
  }
  return runDir;
}

function workersOf(value: string | undefined): number {
  if (value === undefined) return 1;
  const workers = Number(value);
  if (!/^\d+$/.test(value) || workers < 1 || workers > MAX_WORKERS) {
    throw new CommandError(`--workers takes a whole number from 1 to ${MAX_WORKERS}, not "${value}"`);
  }
  return workers;
}

/**
 * The paths of the regular `<prompt-id>.json` files directly in `from`, skipping folders, links, other names and
 * production confirmations.
 */
async function answerFiles(ctx: CommandContext, from: string): Promise<string[]> {
  let entries;
  try {
    entries = await readdir(from, { withFileTypes: true });
  } catch (error) {
    throw new CommandError(`cannot read the answers folder ${from}: ${(error as Error).message}`);
  }
  const files: string[] = [];
  for (const entry of entries) {
    const id = entry.name.endsWith(".json") ? entry.name.slice(0, -".json".length) : undefined;
    if (!entry.isFile() || id === undefined || !PLAIN_NAME.test(id)) {
      if (entry.name.endsWith(".json")) ctx.out.log(`skipped ${entry.name}: not a regular file named for a prompt id`);
      continue;
    }
    if (CONFIRMATION.test(id)) {
      ctx.out.log(`skipped ${entry.name}: a production confirmation takes only an answer given while it waits`);
      continue;
    }
    files.push(join(from, entry.name));
  }
  return files;
}

async function copyAnswers(files: readonly string[], to: string): Promise<void> {
  await mkdir(to, { recursive: true });
  for (const file of files) await copyFile(file, join(to, basename(file)), constants.COPYFILE_EXCL);
}

/** The shape of summary.json without its `unmapped` list: counts and one line per case. */
export function summary(runId: string, results: readonly CaseResult[]) {
  const count = (status: CaseResult["status"]) => results.filter((result) => result.status === status).length;
  return {
    runId,
    counts: {
      pass: count("pass"),
      fail: count("fail"),
      blocked: count("blocked"),
      followup: count("followup"),
      total: results.length,
    },
    cases: results.map(({ caseId, title, target, status, reason }) => ({
      caseId,
      title,
      target,
      status,
      ...(reason === undefined ? {} : { reason }),
    })),
  };
}

export function summaryText(runId: string, results: readonly CaseResult[], dir: string): string {
  const { counts } = summary(runId, results);
  return [
    `Run ${runId}: ${counts.pass} pass, ${counts.fail} fail, ${counts.blocked} blocked, ${counts.followup} followup.`,
    ...results.map(
      (result) =>
        `  ${result.status.padEnd(8)} ${result.caseId} on ${result.target}${result.reason === undefined ? "" : `: ${result.reason}`}`,
    ),
    `Evidence in ${dir}`,
    "",
  ].join("\n");
}
