import { readFile } from "node:fs/promises";
import { relative, resolve } from "node:path";
import { BRAND } from "@bazam/core/brand";
import { runnerOf } from "@bazam/core/project";
import { newRunId } from "@bazam/core/result";
import { ingestResults } from "@bazam/core/run";
import { CommandError, exitCodeFor, type ExitCode } from "../exit.ts";
import { plural } from "../io.ts";
import type { CommandContext } from "../main.ts";
import { startRun } from "./plan.ts";
import { newRunDir, summary, summaryText } from "./run.ts";

/**
 * Records the cases of one runner target from result files a runner wrote elsewhere, as a run of those cases
 * would, and starts no process. Exits by the statuses as `run` does, and 2 when it cannot start, which includes a
 * file it cannot read.
 */
export async function ingestCommand(ctx: CommandContext): Promise<ExitCode> {
  const { flags } = ctx;
  const [target, ...others] = flags.target ?? [];
  if (target === undefined || others.length > 0) {
    throw new CommandError("ingest takes one --target, the runner target whose runner wrote the files");
  }
  if (ctx.args.length === 0) throw new CommandError("name the result files to ingest");
  const start = await startRun(ctx);
  const { project } = start;
  if (runnerOf(project.config, target) === undefined) {
    const entry = Object.hasOwn(project.config.targets, target) ? project.config.targets[target] : undefined;
    throw new CommandError(
      entry === undefined
        ? `target ${target} is not defined under targets in ${BRAND.configFile}`
        : `target ${target} names a driver, not a runner`,
    );
  }
  const files = ctx.args.map((file) => resolve(ctx.io.cwd, file));
  const runId = flags.run ?? newRunId(new Date(), Math.random);
  const runDir = newRunDir(project.root, runId);
  // read here too, so a file that cannot be read stops the command before its start line
  for (const file of files) {
    await readFile(file).catch((error: Error) => {
      throw new CommandError(`cannot read the result file ${file}: ${error.message}`);
    });
  }
  ctx.out.log(
    `run ${runId}: ${plural(start.cases.length, "case")} on env ${start.env.name} from ${plural(files.length, "file")}`,
  );
  const results = await ingestResults({
    project,
    env: start.env,
    registry: start.registry,
    target,
    cases: start.cases,
    files,
    runDir,
    redactor: ctx.redactor,
    seed: start.seed,
  });
  ctx.out.result(summary(runId, results), summaryText(runId, results, relative(ctx.io.cwd, runDir)));
  return exitCodeFor(results.map((result) => result.status));
}
