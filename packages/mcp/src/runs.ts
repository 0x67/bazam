import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { existsSync } from "node:fs";
import { mkdir, open, readdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import type { CaseFilter } from "@bazam/core/case";
import type { PersonAnswer, PersonPrompt } from "@bazam/core/challenge";
import { newRunId, type RunProgress } from "@bazam/core/result";

/** A run id and a prompt id become file names, as answersFileChannel requires of a prompt id. */
export const PLAIN_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

const SUPERVISOR_FILE = "supervisor.json";
const STDOUT_FILE = "stdout.log";
const STDERR_FILE = "stderr.log";
// enough of the CLI's error output to name why a run stopped
const STDERR_TAIL = 4000;

/** An answer a person can give through a tool; a timeout is the channel's own answer. */
export type ToolAnswer = Exclude<PersonAnswer, { kind: "timeout" }>;

/** `runs/<run-id>/supervisor.json`: the process that runs the cases. */
interface SupervisorRecord {
  runId: string;
  pid: number;
  argv: string[];
  startedAt: string;
  /** Known only when the server that started the run saw the process end. */
  exit?: ProcessExit;
}

interface ProcessExit {
  code: number | null;
  signal: string | null;
}

/** The run's status.json, plus the state of the process that runs it. */
export interface RunStatus extends Omit<RunProgress, "state"> {
  /**
   * `starting` until the run writes status.json; `stopped` when its process ended before the run finished, as after
   * a crash or when the run could not start.
   */
  state: RunProgress["state"] | "starting" | "stopped";
  pid?: number;
  exit?: ProcessExit;
  /** The end of the process's error output, when it stopped. */
  stderr?: string;
}

/**
 * Runs cases in a detached CLI process with the answers-file channel. Status, prompts and answers are files in the
 * run directory, so another supervisor on the same root, as after a server restart, picks the run up.
 */
export class RunSupervisor {
  readonly #root: string;
  readonly #cliPath: string;
  readonly #exits = new Map<string, ProcessExit>();

  /** `cliPath` is the CLI's main script; it runs under this process's Node with the same Node flags. */
  constructor(projectRoot: string, cliPath: string) {
    this.#root = resolve(projectRoot);
    this.#cliPath = cliPath;
  }

  /** Spawns the run and returns once the process is up; a spawn failure throws. */
  async start(filter: CaseFilter, env: string, seed?: number): Promise<{ runId: string }> {
    const runId = newRunId(new Date(), Math.random);
    const runDir = this.#runDir(runId);
    await mkdir(join(this.#root, "runs"), { recursive: true });
    // without recursive, an existing folder throws instead of mixing two runs
    await mkdir(runDir);
    const argv = [
      ...process.execArgv,
      this.#cliPath,
      "run",
      "--json",
      `--run=${runId}`,
      "--channel=answers-file",
      `--env=${env}`,
      `--root=${this.#root}`,
      ...filterFlags(filter),
      ...(seed === undefined ? [] : [`--seed=${seed}`]),
    ];
    // the CLI masks what it writes; its output must never reach this process's stdout, which carries the protocol
    const out = await open(join(runDir, STDOUT_FILE), "w");
    const err = await open(join(runDir, STDERR_FILE), "w");
    try {
      const child = spawn(process.execPath, argv, {
        cwd: this.#root,
        detached: true,
        stdio: ["ignore", out.fd, err.fd],
      });
      const exited = Promise.withResolvers<ProcessExit>();
      child.once("exit", (code, signal) => exited.resolve({ code, signal }));
      await once(child, "spawn");
      child.unref();
      const record: SupervisorRecord = { runId, pid: child.pid!, argv, startedAt: new Date().toISOString() };
      await writeJson(join(runDir, SUPERVISOR_FILE), record);
      void exited.promise.then(async (exit) => {
        this.#exits.set(runId, exit);
        // a failed write leaves the exit known to this supervisor only
        await writeJson(join(runDir, SUPERVISOR_FILE), { ...record, exit }).catch(() => undefined);
      });
    } finally {
      await out.close();
      await err.close();
    }
    return { runId };
  }

  async status(runId: string): Promise<RunStatus> {
    const runDir = this.#runDir(runId);
    const progress = await readJson<RunProgress>(join(runDir, "status.json"));
    const { record, exit, ended } = await this.#process(runId);
    if (progress === undefined && record === undefined) throw new Error(`no run ${runId} has started`);
    const state = progress?.state === "finished" ? "finished" : ended ? "stopped" : (progress?.state ?? "starting");
    const status: RunStatus = {
      runId,
      state,
      total: progress?.total ?? 0,
      pendingPrompts: progress?.pendingPrompts ?? 0,
      results: progress?.results ?? [],
    };
    if (record !== undefined) status.pid = record.pid;
    if (exit !== undefined) status.exit = exit;
    if (state === "stopped") status.stderr = await stderrTail(runDir);
    return status;
  }

  /** The prompts waiting for an answer, by id; none once the run's process has ended. */
  async prompts(runId: string): Promise<PersonPrompt[]> {
    const runDir = this.#runDir(runId);
    // a process killed while it waited leaves its prompt files behind, and nothing reads an answer to them
    if ((await this.#process(runId)).ended) return [];
    const entries = await readdir(join(runDir, "prompts"), { withFileTypes: true }).catch((error: unknown) => {
      if (isMissing(error)) return undefined;
      throw error;
    });
    if (entries === undefined) {
      if (!existsSync(runDir)) throw new Error(`no run ${runId} has started`);
      return [];
    }
    const prompts: PersonPrompt[] = [];
    // only exact `<id>.json` names, which skips the temp files written in passing and the done/ folder
    for (const entry of entries.filter((e) => e.isFile() && promptIdOf(e.name) !== undefined).sort(byName)) {
      // a prompt answered or timed out since readdir has moved to done/
      const prompt = await readJson<PersonPrompt>(join(runDir, "prompts", entry.name));
      if (prompt !== undefined) prompts.push(prompt);
    }
    return prompts;
  }

  /**
   * Writes `answers/<prompt-id>.json` for a pending prompt of a live run, through a rename as the channel requires.
   * Refuses an answer of a kind the prompt does not take, which the run would turn into a blocked case. The file holds
   * a value as given, which is safe only because the run's channel claims and deletes it.
   */
  async answer(runId: string, promptId: string, answer: ToolAnswer): Promise<void> {
    const runDir = this.#runDir(runId);
    if (!PLAIN_NAME.test(promptId)) throw new Error(`prompt id "${promptId}" is not a plain file name`);
    const promptFile = join(runDir, "prompts", `${promptId}.json`);
    const prompt = await readJson<PersonPrompt>(promptFile);
    if (prompt === undefined) {
      throw new Error(`prompt ${promptId} is not pending in run ${runId}; prompt_list shows the prompts still waiting`);
    }
    if ((await this.#process(runId)).ended) {
      throw new Error(`run ${runId} has stopped, so prompt ${promptId} can no longer be answered`);
    }
    const refusal = answerRefusal(prompt.ask, answer);
    if (refusal !== undefined) throw new Error(`prompt ${promptId} asks for ${prompt.ask}: ${refusal}`);
    const answers = join(runDir, "answers");
    await mkdir(answers, { recursive: true });
    const answerFile = join(answers, `${promptId}.json`);
    await writeJson(answerFile, answer);
    // once the prompt has timed out or the process has ended, nothing claims the answer, so take it back unless the
    // run claimed it first
    if (existsSync(promptFile) && !(await this.#process(runId)).ended) return;
    if (await removeFile(answerFile)) {
      throw new Error(`prompt ${promptId} is not pending in run ${runId}; prompt_list shows the prompts still waiting`);
    }
  }

  /** The run's process as supervisor.json and this supervisor know it; a run started some other way has no record. */
  async #process(
    runId: string,
  ): Promise<{ record: SupervisorRecord | undefined; exit: ProcessExit | undefined; ended: boolean }> {
    const record = await readJson<SupervisorRecord>(join(this.#runDir(runId), SUPERVISOR_FILE));
    const exit = this.#exits.get(runId) ?? record?.exit;
    return { record, exit, ended: record !== undefined && (exit !== undefined || !isAlive(record.pid)) };
  }

  /** `runs/<run-id>` under the root, refusing an id that could climb out of runs/. */
  #runDir(runId: string): string {
    if (!PLAIN_NAME.test(runId)) throw new Error(`run id "${runId}" is not a plain file name`);
    return join(this.#root, "runs", runId);
  }
}

/** The CLI's selection flags, in the `--flag=value` form so a value starting with a dash stays a value. */
function filterFlags(filter: CaseFilter): string[] {
  const flags: [string, readonly string[] | undefined][] = [
    ["case", filter.ids],
    ["domain", filter.domains],
    ["stage", filter.stages],
    ["target", filter.targets],
    ["link", filter.links],
    ["tag", filter.tags],
  ];
  return flags.flatMap(([flag, values]) => (values ?? []).map((value) => `--${flag}=${value}`));
}

// mirrors the checks in core's challenge/human-resolver.ts and challenge/guided.ts, which block the case otherwise
function answerRefusal(ask: PersonPrompt["ask"], answer: ToolAnswer): string | undefined {
  switch (ask) {
    case "verdict":
      return answer.kind === "verdict" ? undefined : "answer with a verdict";
    case "action":
      // a human-only kind must never carry a value, so none is written for it
      return answer.kind === "value" ? "answer done or a verdict, never a value" : undefined;
    case "value":
      if (answer.kind === "value") return undefined;
      if (answer.kind === "verdict" && answer.verdict !== "pass") return undefined;
      return "answer with the value, or a fail or blocked verdict";
  }
}

function promptIdOf(name: string): string | undefined {
  if (!name.endsWith(".json")) return undefined;
  const id = name.slice(0, -".json".length);
  return PLAIN_NAME.test(id) ? id : undefined;
}

// signal 0 tests for the process; EPERM means it lives under another user
function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

async function stderrTail(runDir: string): Promise<string> {
  const text = await readFile(join(runDir, STDERR_FILE), "utf8").catch(() => "");
  return text.slice(-STDERR_TAIL);
}

async function readJson<T>(file: string): Promise<T | undefined> {
  let text: string;
  try {
    text = await readFile(file, "utf8");
  } catch (error) {
    if (isMissing(error)) return undefined;
    throw error;
  }
  return JSON.parse(text) as T;
}

/** Writes through a unique temp name and a rename, so a reader never sees half a file. */
async function writeJson(file: string, value: unknown): Promise<void> {
  const temp = `${file}.${randomUUID()}.tmp`;
  await writeFile(temp, `${JSON.stringify(value, null, 2)}\n`);
  await rename(temp, file);
}

/** Deletes `file` and tells whether it was there. */
async function removeFile(file: string): Promise<boolean> {
  try {
    await unlink(file);
    return true;
  } catch (error) {
    if (isMissing(error)) return false;
    throw error;
  }
}

function isMissing(error: unknown): boolean {
  return (error as NodeJS.ErrnoException).code === "ENOENT";
}

function byName(a: { name: string }, b: { name: string }): number {
  return a.name < b.name ? -1 : a.name > b.name ? 1 : 0;
}
