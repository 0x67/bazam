import { spawn } from "node:child_process";
import { createWriteStream } from "node:fs";
import { glob, mkdir, stat } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { finished } from "node:stream/promises";
import {
  CASES_VAR,
  CHALLENGE_TOKEN_VAR,
  CHALLENGE_URL_VAR,
  ENV_VAR,
  RUN_ID_VAR,
  type ChallengeService,
} from "../challenge/index.ts";
import type { RunnerConfig } from "../project.ts";
import type { Redactor } from "../redact/index.ts";

// what shells and env(1) exit with for a command that is not found or that cannot be run
const SPAWN_FAILURES: Readonly<Record<string, number>> = { ENOENT: 127, EACCES: 126 };
const KILL_AFTER_MS = 10_000;
// file systems with coarse timestamps can date a file up to 2 s before the spawn
const MTIME_SLACK_MS = 2000;
// a process the suite started in the background can hold its output open after the suite exits
const OUTPUT_DRAIN_MS = 5000;

export interface RunnerExit {
  code: number | null;
  signal: string | null;
  timedOut: boolean;
  /** Set when the command could not start; `code` is then 127 for ENOENT and 126 for EACCES. */
  spawnError?: string;
}

export interface ExternalSuite {
  target: string;
  runnerName: string;
  runner: RunnerConfig;
  /** The runner's env, then the target's, placeholders resolved. */
  env: Record<string, string>;
  caseIds: readonly string[];
}

export interface ExternalSuiteDeps {
  root: string;
  runDir: string;
  runId: string;
  envName: string;
  /** The run's service, started before the first unit. */
  service: ChallengeService;
  redactor: Redactor;
  signal: AbortSignal;
  now(): Date;
  /** The variable names in `trackers.<t>.secrets`, left out of the child's environment. */
  withheldVars: readonly string[];
  /** Writes a line to the run log; runExternalSuite calls it outside any case's log context. */
  log(line: string): void;
}

export interface ExternalSuiteRun {
  exit: RunnerExit;
  /** Result files written during the run, relative to the runner's cwd. */
  files: string[];
  /** Older matches, left alone. */
  skipped: string[];
  spawnedAt: Date;
}

/**
 * Runs the runner's command once without a shell, with the challenge service's variables and the target's case
 * ids in its environment. Writes its output, masked, to `runner-<target>/runner.log` and the run log. The signal
 * sends SIGINT; `timeoutMinutes` sends SIGTERM, then SIGKILL 10 s later. Lists the result files after the exit.
 */
export async function runExternalSuite(
  suite: ExternalSuite,
  deps: ExternalSuiteDeps,
): Promise<ExternalSuiteRun> {
  const cwd = resolve(deps.root, suite.runner.cwd);
  const logFile = join(deps.runDir, `runner-${suite.target}`, "runner.log");
  await mkdir(dirname(logFile), { recursive: true });
  const runnerLog = createWriteStream(logFile, { flags: "a" });
  const written = finished(runnerLog);
  // awaited once the runner has exited; this handler keeps a write error before then from counting as unhandled
  written.catch(() => undefined);
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    ...suite.env,
    [CHALLENGE_URL_VAR]: deps.service.url.href,
    [CHALLENGE_TOKEN_VAR]: deps.service.token,
    [RUN_ID_VAR]: deps.runId,
    [ENV_VAR]: deps.envName,
    [CASES_VAR]: suite.caseIds.join(","),
  };
  for (const name of deps.withheldVars) delete env[name];
  const line = (text: string): void => {
    const masked = deps.redactor.text(text);
    runnerLog.write(`${masked}\n`);
    deps.log(`[${suite.target}] ${masked}`);
  };
  const spawnedAt = deps.now();
  const exit = await runChild(suite.runner.command, {
    cwd,
    env,
    signal: deps.signal,
    timeoutMs: suite.runner.timeoutMinutes * 60_000,
    line,
  });
  runnerLog.end();
  await written;
  if (exit.spawnError !== undefined || deps.signal.aborted)
    return { exit, files: [], skipped: [], spawnedAt };
  const { files, skipped } = await resultFiles(suite.runner.results, cwd, spawnedAt);
  for (const file of skipped)
    deps.log(`[${suite.target}] skipped ${file}: written before this run's runner started`);
  return { exit, files, skipped, spawnedAt };
}

interface ChildOptions {
  cwd: string;
  env: NodeJS.ProcessEnv;
  signal: AbortSignal;
  timeoutMs: number;
  line: (text: string) => void;
}

// mirrors runChild in the CLI's exec command, which core cannot import
function runChild(command: readonly string[], options: ChildOptions): Promise<RunnerExit> {
  const [file = "", ...args] = command;
  const child = spawn(file, args, {
    cwd: options.cwd,
    env: options.env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  for (const stream of [child.stdout, child.stderr])
    createInterface({ input: stream, crlfDelay: Infinity }).on("line", options.line);
  let timedOut = false;
  const timers: NodeJS.Timeout[] = [];
  const interrupt = (): void => {
    child.kill("SIGINT");
  };
  timers.push(
    setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
      timers.push(setTimeout(() => child.kill("SIGKILL"), KILL_AFTER_MS));
    }, options.timeoutMs),
  );
  if (options.signal.aborted) interrupt();
  else options.signal.addEventListener("abort", interrupt, { once: true });
  child.once("exit", () => {
    timers.push(
      setTimeout(() => {
        child.stdout.destroy();
        child.stderr.destroy();
      }, OUTPUT_DRAIN_MS),
    );
  });
  return new Promise<RunnerExit>((done) => {
    child.once("error", (error: NodeJS.ErrnoException) => {
      // an error after the spawn, such as a failed kill, leaves the exit to the close event
      if (child.pid !== undefined) return;
      done({
        code: SPAWN_FAILURES[error.code ?? ""] ?? null,
        signal: null,
        timedOut: false,
        spawnError: error.message,
      });
    });
    child.once("close", (code, signal) => done({ code, signal, timedOut }));
  }).finally(() => {
    for (const timer of timers) clearTimeout(timer);
    options.signal.removeEventListener("abort", interrupt);
  });
}

/** The regular files the glob matches, split by whether they were written after the spawn, less the slack. */
async function resultFiles(
  pattern: string,
  cwd: string,
  spawnedAt: Date,
): Promise<{ files: string[]; skipped: string[] }> {
  const files: string[] = [];
  const skipped: string[] = [];
  for await (const path of glob(pattern, { cwd })) {
    const info = await stat(join(cwd, path)).catch(() => undefined);
    if (info?.isFile() !== true) continue;
    (info.mtimeMs >= spawnedAt.getTime() - MTIME_SLACK_MS ? files : skipped).push(path);
  }
  return { files: files.sort(), skipped: skipped.sort() };
}
