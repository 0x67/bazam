import { join } from "node:path";
import { selectCases, Stage, type CaseFilter, type LoadedCase } from "@bazam/core/case";
import { RunValues, type Environment } from "@bazam/core/env";
import type { ProjectConfig } from "@bazam/core/project";
import { newRunId } from "@bazam/core/result";
import { planCases, type RunOptions, type RunPlan } from "@bazam/core/run";
import { CommandError, ExitCode } from "../exit.ts";
import { plural } from "../io.ts";
import type { CommandContext, Flags, Workspace } from "../main.ts";

const DEFAULT_CHANNEL = "terminal";
// seven digits at most, so the redactor's rule for runs of eight or more leaves a printed seed readable
const RANDOM_SEED_LIMIT = 10_000_000;
// a run id and a prompt id become file names, as answersFileChannel requires of a prompt id
export const PLAIN_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

/** What a plan and a run start from: the project, the env, the selected cases and the --target filter. */
export interface RunStart extends Workspace {
  env: Environment;
  cases: LoadedCase[];
  /** The --target flag and the suite's targets; undefined when neither names one. */
  targets: string[] | undefined;
  channel: string;
  seed: number;
}

/** Prints what a run would do, with no step run and no login made. */
export async function planCommand(ctx: CommandContext): Promise<ExitCode> {
  const start = await startRun(ctx);
  const startedAt = new Date();
  const plan = await planCases(runOptions(ctx, start, newRunId(startedAt, Math.random), startedAt));
  ctx.out.result(plan, planText(plan, start.project.config));
  return ExitCode.Pass;
}

/**
 * Loads the project and settles the env, the selection, the channel and the seed. Refuses to start, as a run
 * does, when the project has load issues, a name is unknown or no case is selected.
 */
export async function startRun(ctx: CommandContext): Promise<RunStart> {
  const { flags } = ctx;
  const workspace = await ctx.load();
  const { project, registry } = workspace;
  const loadErrors = project.issues.filter((issue) => issue.severity === "error");
  if (loadErrors.length > 0)
    throw new CommandError("the project has load issues; fix them and start again", loadErrors);
  const envs = Object.keys(project.config.envs);
  if (flags.env === undefined) throw new CommandError(`--env is required; envs: ${known(envs)}`);
  const env = project.config.envs[flags.env];
  if (env === undefined) throw new CommandError(`unknown env "${flags.env}"; envs: ${known(envs)}`);
  const channel = flags.channel ?? DEFAULT_CHANNEL;
  // throws for a channel no plugin registered, naming the known ones
  registry.channel(channel);
  const { cases, targets } = selection(workspace, flags);
  if (cases.length === 0) throw new CommandError("no case matches the selection");
  return { ...workspace, env, cases, targets, channel, seed: seedOf(flags) };
}

export function runOptions(ctx: CommandContext, start: RunStart, runId: string, startedAt: Date): RunOptions {
  const { project, registry, env, cases, targets, channel, seed } = start;
  const runDir = runDirOf(project.root, runId);
  return {
    project,
    env,
    cases,
    registry,
    channel: registry.channel(channel)(runDir),
    runDir,
    runValues: new RunValues(runId, startedAt, seed),
    seed,
    redactor: ctx.redactor,
    signal: ctx.io.signal,
    ...(targets === undefined ? {} : { targets }),
  };
}

/** `runs/<run-id>` under the root, refusing an id that is not a plain file name, so it cannot climb out of runs/. */
export function runDirOf(root: string, runId: string): string {
  if (!PLAIN_NAME.test(runId)) throw new CommandError(`run id "${runId}" is not a plain file name`);
  return join(root, "runs", runId);
}

/**
 * The cases that match the suite and the flags both. A pass that names no stages falls back to the stages that
 * run and would drop a stage the other names, such as retired, so both passes take the stages the suite and
 * --stage name together. --target also selects: a case none of whose targets the filter keeps is left out
 * instead of planned as blocked.
 */
export function selection(workspace: Workspace, flags: Flags): { cases: LoadedCase[]; targets: string[] | undefined } {
  const { project } = workspace;
  const suite = flags.suite === undefined ? undefined : project.suites.get(flags.suite);
  if (flags.suite !== undefined && suite === undefined) {
    throw new CommandError(`unknown suite "${flags.suite}"; suites: ${known([...project.suites.keys()])}`);
  }
  const own = flagFilter(flags);
  const targets = both(suite?.targets, own.targets);
  const stages = both(suite?.stages, own.stages);
  const pool =
    suite === undefined
      ? project.cases
      : selectCases(project.cases, { ...suite, ...(stages === undefined ? {} : { stages }) });
  const cases = selectCases(pool, {
    ...own,
    ...(stages === undefined ? {} : { stages }),
    ...(targets === undefined ? {} : { targets }),
  });
  return { cases, targets };
}

function flagFilter(flags: Flags): CaseFilter {
  const stages = flags.stage?.map((stage) => {
    const parsed = Stage.safeParse(stage);
    if (!parsed.success) throw new CommandError(`unknown stage "${stage}"; stages: ${Stage.options.join(", ")}`);
    return parsed.data;
  });
  return {
    ...(flags.case === undefined ? {} : { ids: flags.case }),
    ...(flags.domain === undefined ? {} : { domains: flags.domain }),
    ...(stages === undefined ? {} : { stages }),
    ...(flags.target === undefined ? {} : { targets: flags.target }),
    ...(flags.link === undefined ? {} : { links: flags.link }),
    ...(flags.tag === undefined ? {} : { tags: flags.tag }),
  };
}

function both<T>(a: T[] | undefined, b: T[] | undefined): T[] | undefined {
  if (a === undefined) return b;
  if (b === undefined) return a;
  return a.filter((value) => b.includes(value));
}

function seedOf(flags: Flags): number {
  if (flags.seed === undefined) return Math.floor(Math.random() * RANDOM_SEED_LIMIT);
  const seed = Number(flags.seed);
  if (!/^\d+$/.test(flags.seed) || !Number.isSafeInteger(seed)) {
    throw new CommandError(`--seed takes a whole number, not "${flags.seed}"`);
  }
  return seed;
}

function known(names: readonly string[]): string {
  return names.length === 0 ? "none" : names.join(", ");
}

function planText(plan: RunPlan, config: ProjectConfig): string {
  const lines = [
    `Plan for env ${plan.env}: ${plural(plan.cases.length, "case")}, ${plural(plan.personSteps, "person step")}.`,
  ];
  for (const planned of plan.cases) {
    if (planned.blocked !== undefined) {
      lines.push(`  ${planned.caseId} on ${planned.target}: blocked: ${planned.blocked}`);
      continue;
    }
    lines.push(`  ${planned.caseId} on ${planned.target}`);
    const runner = planned.runner === undefined ? undefined : config.runners[planned.runner];
    if (runner !== undefined) lines.push(`    runner ${planned.runner}: ${runner.command.join(" ")}`);
    for (const login of planned.logins) lines.push(`    login ${login.identity}/${login.surface}: ${login.mode}`);
    for (const challenge of planned.challenges) {
      lines.push(`    step ${challenge.step} ${challenge.kind}: ${challenge.resolver ?? "no resolver"}`);
    }
  }
  for (const { runner } of plan.confirmations) {
    lines.push(`  needs a yes before it runs in production env ${plan.env}: runner ${runner}`);
  }
  return `${lines.join("\n")}\n`;
}
