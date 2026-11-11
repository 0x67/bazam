import { spawn } from "node:child_process";
import { constants } from "node:os";
import { join } from "node:path";
import { BRAND } from "@bazam/core/brand";
import {
  CHALLENGE_TOKEN_VAR,
  CHALLENGE_URL_VAR,
  startChallengeService,
  type ChallengeServiceDeps,
} from "@bazam/core/challenge";
import { guardedHttp } from "@bazam/core/driver";
import { newRunId } from "@bazam/core/result";
import { resolveSecret } from "@bazam/core/secrets";
import { CommandError } from "../exit.ts";
import type { CommandContext } from "../main.ts";
import { envOf } from "./keepalive.ts";
import { runDirOf } from "./plan.ts";

const DEFAULT_CHANNEL = "terminal";
// what shells and env(1) exit with for a command that is not found or that cannot be run
const SPAWN_FAILURES: Readonly<Record<string, number>> = { ENOENT: 127, EACCES: 126 };

export interface ExecOptions {
  command: string;
  args: readonly string[];
  cwd: string;
  service: ChallengeServiceDeps;
  /** "ignore" leaves the terminal's input to the terminal channel, which reads a person's answers from it. */
  stdin: "inherit" | "ignore";
  /** Aborting it sends the command SIGINT; the command's exit code still decides the result. */
  signal: AbortSignal;
  log(line: string): void;
}

/**
 * Runs the command with the challenge service's URL and token in its environment and its output on this
 * process's own, then stops the service. Returns the command's exit code: 128 plus the signal number when a
 * signal ended it, 127 when it was not found and 126 when it could not be run.
 */
export async function runWithChallengeService(options: ExecOptions): Promise<number> {
  const service = await startChallengeService(options.service);
  try {
    return await runChild(options, {
      [CHALLENGE_URL_VAR]: service.url.href,
      [CHALLENGE_TOKEN_VAR]: service.token,
    });
  } finally {
    await service.close();
  }
}

export async function execCommand(ctx: CommandContext): Promise<number> {
  const [command, ...args] = ctx.args;
  if (command === undefined) {
    throw new CommandError(
      `exec needs a command to run: ${BRAND.name} exec --env <env> -- <command> [args]`,
    );
  }
  const { config, registry } = await ctx.loadPlugins();
  const env = envOf(config, ctx.flags.env);
  const channel = ctx.flags.channel ?? DEFAULT_CHANNEL;
  // throws for a channel no plugin registered, naming the known ones
  const channelFor = registry.channel(channel);
  const runId = newRunId(new Date(), Math.random);
  const providers = registry.secretProviders(config.secrets.providers);
  const log = (line: string): void => ctx.out.log(line);
  return runWithChallengeService({
    command,
    args,
    cwd: ctx.io.cwd,
    service: {
      env,
      registry,
      // the answers-file channel keeps its prompts under runs/<run-id>, as a run does
      channel: channelFor(runDirOf(ctx.root, runId)),
      http: guardedHttp({ env, redactor: ctx.redactor, log }),
      stateDir: join(ctx.root, BRAND.stateDir),
      secrets: (key) => resolveSecret(key, providers, ctx.redactor),
      redactor: ctx.redactor,
      runId,
      log,
    },
    stdin: channel === DEFAULT_CHANNEL ? "ignore" : "inherit",
    signal: ctx.io.signal,
    log,
  });
}

async function runChild(options: ExecOptions, vars: Record<string, string>): Promise<number> {
  const { signal } = options;
  // the child's output is its own, so it goes straight to this process's stdout and stderr
  const child = spawn(options.command, options.args, {
    cwd: options.cwd,
    env: { ...process.env, ...vars },
    stdio: [options.stdin, "inherit", "inherit"],
  });
  const interrupt = (): void => {
    child.kill("SIGINT");
  };
  if (signal.aborted) interrupt();
  else signal.addEventListener("abort", interrupt, { once: true });
  try {
    const [code, ended] = await new Promise<[number | null, NodeJS.Signals | null]>(
      (done, fail) => {
        child.once("error", fail);
        child.once("exit", (exitCode, exitSignal) => done([exitCode, exitSignal]));
      },
    );
    if (code !== null) return code;
    const numbers: Readonly<Record<string, number | undefined>> = constants.signals;
    return 128 + (ended === null ? 0 : (numbers[ended] ?? 0));
  } catch (error) {
    const code = SPAWN_FAILURES[(error as NodeJS.ErrnoException).code ?? ""];
    if (code === undefined) throw error;
    options.log(`error: cannot run ${options.command}: ${(error as Error).message}`);
    return code;
  } finally {
    signal.removeEventListener("abort", interrupt);
  }
}
