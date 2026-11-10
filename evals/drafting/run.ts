/**
 * The drafting eval. For each sample ticket in tickets/, an agent drafts cases in a fresh copy of the example project,
 * and the harness grades the draft three ways: `check` reports no errors, the cases that link the ticket pass against
 * the demo app and one of them is new or has new steps or checks, and a ticket about a behavior a case already covers
 * adds no case id. README.md describes the agent contract, the ticket format and the result file. It runs by hand
 * only, since every attempt is one agent session.
 *
 *   pnpm eval:drafting
 *   EVAL_AGENT_CMD="<command>" EVAL_REPEATS=1 pnpm eval:drafting
 */
import { execFileSync, spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { copyFile, mkdir, mkdtemp, readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { constants, tmpdir } from "node:os";
import { dirname, extname, join, relative, resolve } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { isDeepStrictEqual } from "node:util";
import { BRAND } from "../../packages/core/src/brand.ts";

const REPO = join(import.meta.dirname, "..", "..");
const EXAMPLES = join(REPO, "examples");
// the CLI from its sources, so the eval needs no build
const CLI = join(REPO, "packages", "cli", "src", "main.ts");
const SKILL = join(REPO, "skills", "author", "SKILL.md");
const TICKETS = resolve(process.env.EVAL_TICKETS || join(import.meta.dirname, "tickets"));
const RESULTS = join(import.meta.dirname, "results");

// the eval has no dependencies of its own, so it borrows the core package's YAML parser
const { parse: parseYaml } = createRequire(join(REPO, "packages", "core", "package.json"))("yaml") as {
  parse: (source: string) => unknown;
};

// the env, the tracker and the hosts of the example project's demo app
const ENV = "demo";
const TRACKER = "jira";
const DEMO_PROBES = ["http://localhost:3300/login", "http://localhost:8325/readyz"];

const AGENT_TIMEOUT_MS = 15 * 60_000;
const RUN_TIMEOUT_MS = 10 * 60_000;
const CLI_TIMEOUT_MS = 2 * 60_000;
// how long a process group gets after SIGTERM before SIGKILL
const STOP_GRACE_MS = 5_000;
const POLL_MS = 250;
const GRADED_RUN_ID = "eval-graded";

// --restricted drops Bash and the other tools that run code, skips the user's settings files with their allow rules,
// default mode and hooks, and keeps the file tools inside the copy; --tools and dontAsk leave only the tools named here
const DEFAULT_AGENT_CMD = [
  "claude -p --output-format json",
  "--restricted --tools Read,Glob,Grep,Edit,Write --permission-mode dontAsk",
  '--mcp-config "$EVAL_MCP_CONFIG" --strict-mcp-config',
  '--append-system-prompt "$(cat "$EVAL_SKILL_FILE")"',
  `--allowedTools 'mcp__${BRAND.mcpServerName}__*' Read Glob Grep Edit Write`,
  "--no-session-persistence",
].join(" ");

// what a draft or a run writes; the bare import() that loads plugins and hooks refuses each of these (JSON needs a
// type attribute), but a YAML config can still start a process, which the config guard checks
const DATA_EXTENSIONS = new Set([
  ".yaml",
  ".yml",
  ".json",
  ".xml",
  ".md",
  ".txt",
  ".log",
  ".env",
  ".png",
  ".jpg",
  ".jpeg",
  ".webm",
  ".zip",
]);

// the config keys that can start a process: an object plugins entry, a runner, and a target that names one
const CODE_KEYS = ["plugins", "runners", "targets"] as const;

// what the harness answers for the person in the graded run, by the prompt's ask
const ANSWERS = {
  verdict: { kind: "verdict", verdict: "pass", note: "eval harness" },
  action: { kind: "done" },
  value: { kind: "verdict", verdict: "blocked", note: "eval harness has no value" },
} as const;
type Ask = keyof typeof ANSWERS;

const PERSON_NOTE =
  "The harness answers every person prompt in the graded run: pass for a verdict, done for an action and blocked " +
  "for a value. The run grade of a guided ticket measures that the case runs and its observe agrees, not a " +
  "person's judgment.";

const KINDS = ["new", "extend", "guided"] as const;
type Kind = (typeof KINDS)[number];

// A terminal sends Ctrl-C to the harness alone, since every child leads its own process group. The harness then
// stops the children itself, so the copy is deleted and the attempts so far are written.
const stopping = new AbortController();
let stoppedBy: NodeJS.Signals | undefined;

interface Ticket {
  file: string;
  key: string;
  kind: Kind;
  /** The case an extend ticket adds to. */
  case?: string;
  /** What the agent sees: the ticket without its front matter. */
  body: string;
}

interface Exited {
  code: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  timedOut: boolean;
  seconds: number;
}

interface AgentRecord {
  exit: number | null;
  signal: NodeJS.Signals | null;
  timedOut: boolean;
  seconds: number;
  models: string[];
}

interface CheckGrade {
  pass: boolean;
  errors: number;
  warnings: number;
  issues: { ruleId: string; file: string; line: number }[];
  error?: string;
}

interface IdsGrade {
  /** Null for a new or guided ticket, which may add ids. */
  pass: boolean | null;
  added: string[];
  error?: string;
}

interface CaseLine {
  caseId: string;
  target: string;
  status: string;
  reason?: string;
}

interface RunGrade {
  pass: boolean;
  exit: number | null;
  timedOut: boolean;
  counts?: Record<string, number>;
  cases?: CaseLine[];
  /** The cases the run selected that are new or have new steps or checks; the grade needs one. */
  drafted: string[];
  error?: string;
  /** The person prompts the harness answered, by ask. */
  prompts: Record<Ask, number>;
}

interface Attempt {
  agent: AgentRecord;
  check: CheckGrade;
  run: RunGrade;
  ids: IdsGrade;
}

interface Rate {
  passed: number;
  graded: number;
  rate: number;
}

/** Parses `source` into a ticket: the `key: value` lines of its front matter and the body that follows. */
function parseTicket(file: string, source: string): Ticket {
  const text = source.replaceAll("\r\n", "\n");
  const match = /^---\n([\s\S]*?)\n---\n/.exec(text);
  if (match === null) throw new Error(`ticket ${file} has no front matter`);
  const meta = new Map<string, string>();
  for (const line of match[1]!.split("\n")) {
    const pair = /^([a-z]+):\s*(\S+)\s*$/.exec(line);
    if (pair === null) throw new Error(`ticket ${file}: front matter line "${line}" is not "key: value"`);
    meta.set(pair[1]!, pair[2]!);
  }
  const key = meta.get("key");
  const kind = KINDS.find((known) => known === meta.get("kind"));
  const extended = meta.get("case");
  if (key === undefined || !/^[A-Z][A-Z0-9]*-\d+$/.test(key))
    throw new Error(`ticket ${file} needs a key such as DEMO-501`);
  if (kind === undefined) throw new Error(`ticket ${file} needs a kind: ${KINDS.join(", ")}`);
  if ((kind === "extend") !== (extended !== undefined)) {
    throw new Error(`ticket ${file}: an extend ticket names its case, and only an extend ticket does`);
  }
  const body = text.slice(match[0].length).trim();
  return { file, key, kind, ...(extended === undefined ? {} : { case: extended }), body };
}

async function loadTickets(): Promise<Ticket[]> {
  const files = (await readdir(TICKETS)).filter((file) => file.endsWith(".md")).sort();
  const tickets = await Promise.all(
    files.map(async (file) => parseTicket(file, await readFile(join(TICKETS, file), "utf8"))),
  );
  if (tickets.length === 0) throw new Error(`no tickets in ${TICKETS}`);
  const keys = tickets.map((ticket) => ticket.key);
  const repeated = keys.find((key, index) => keys.indexOf(key) !== index);
  if (repeated !== undefined) throw new Error(`two tickets have the key ${repeated}`);
  return tickets;
}

function agentPrompt(ticket: Ticket): string {
  return [
    `Draft the ${BRAND.name} test cases the ticket below needs, in the project in the current directory.`,
    `Follow the ${BRAND.skillName} skill and use the ${BRAND.mcpServerName} MCP tools.`,
    "No person is available in this session: leave every person prompt unanswered, and finish once the cases are drafted.",
    "Afterwards the cases that link this ticket are checked and run against the demo app.",
    "",
    ticket.body,
    "",
  ].join("\n");
}

/** False when the group has no process left, or none this process may signal. */
function signalGroup(pid: number, signal: NodeJS.Signals | 0): boolean {
  try {
    process.kill(-pid, signal);
    return true;
  } catch (error) {
    const { code } = error as NodeJS.ErrnoException;
    if (code === "ESRCH" || code === "EPERM") return false;
    throw error;
  }
}

async function stopGroup(pid: number): Promise<void> {
  if (!signalGroup(pid, "SIGTERM")) return;
  for (const end = Date.now() + STOP_GRACE_MS; Date.now() < end && signalGroup(pid, 0);) await sleep(100);
  signalGroup(pid, "SIGKILL");
}

interface GroupOptions {
  cwd: string;
  timeoutMs: number;
  env?: NodeJS.ProcessEnv;
  input?: string;
  stderr?: "inherit" | "ignore";
}

/**
 * Runs a command as the leader of its own process group. The group is stopped on a timeout or when the eval is
 * stopped, and whatever is left of it once the leader exits is killed, such as an MCP server an agent started. Once
 * the eval is stopped, it starts nothing and rejects with the reason.
 */
function runGroup(command: string, args: readonly string[], options: GroupOptions): Promise<Exited> {
  stopping.signal.throwIfAborted();
  const started = Date.now();
  const child = spawn(command, args, {
    cwd: options.cwd,
    env: options.env ?? process.env,
    detached: true,
    stdio: [options.input === undefined ? "ignore" : "pipe", "pipe", options.stderr ?? "ignore"],
  });
  let stdout = "";
  child.stdout!.setEncoding("utf8").on("data", (chunk: string) => {
    stdout += chunk;
  });
  if (options.input !== undefined) {
    // an agent may exit without reading its prompt, which closes the pipe; its exit status tells the rest
    child.stdin!.on("error", () => undefined);
    child.stdin!.end(options.input);
  }
  const stop = (): void => {
    if (child.pid !== undefined) void stopGroup(child.pid);
  };
  stopping.signal.addEventListener("abort", stop);
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    stop();
  }, options.timeoutMs);
  const settle = (): void => {
    clearTimeout(timer);
    stopping.signal.removeEventListener("abort", stop);
  };
  child.once("exit", () => {
    settle();
    if (child.pid !== undefined) signalGroup(child.pid, "SIGKILL");
  });
  return new Promise((resolve, reject) => {
    child.once("error", (error) => {
      settle();
      reject(error);
    });
    child.once("close", (code, signal) => {
      if (stopping.signal.aborted) reject(stopping.signal.reason as Error);
      else resolve({ code, signal, stdout, timedOut, seconds: Math.round((Date.now() - started) / 1000) });
    });
  });
}

function cli(project: string, args: readonly string[], timeoutMs = CLI_TIMEOUT_MS): Promise<Exited> {
  return runGroup(process.execPath, ["--conditions=development", CLI, ...args, "--root", project], {
    cwd: project,
    timeoutMs,
  });
}

/** The command's JSON output when it holds `key`, else why it does not. */
function outputOf<T>(exited: Exited, key: string): T | string {
  let json: unknown;
  try {
    json = JSON.parse(exited.stdout);
  } catch {
    json = undefined;
  }
  if (typeof json === "object" && json !== null) {
    if ("error" in json) return String(json.error);
    if (key in json) return json as T;
  }
  if (exited.timedOut) return "timed out";
  return `exited with ${exited.code ?? exited.signal}`;
}

/**
 * What a fresh clone holds of examples/: the files git does not ignore, without the demo app. Then the two inputs a
 * run reads that git ignores: the secrets file when there is one, and the local fixtures, or a copy of the example
 * ones when there are none.
 */
async function copyExamples(to: string): Promise<void> {
  const listed = execFileSync("git", ["ls-files", "-z", "--cached", "--others", "--exclude-standard"], {
    cwd: EXAMPLES,
    encoding: "utf8",
  });
  for (const file of listed.split("\0")) {
    if (file === "" || file.startsWith("demo-app/")) continue;
    await copyInto(join(EXAMPLES, file), join(to, file));
  }
  const secrets = join(BRAND.stateDir, "secrets.env");
  if (existsSync(join(EXAMPLES, secrets))) await copyInto(join(EXAMPLES, secrets), join(to, secrets));
  const local = join(EXAMPLES, "fixtures", "identities.local.yaml");
  const fixtures = existsSync(local) ? local : join(EXAMPLES, "fixtures", "identities.example.yaml");
  await copyInto(fixtures, join(to, "fixtures", "identities.local.yaml"));
}

async function copyInto(from: string, to: string): Promise<void> {
  await mkdir(dirname(to), { recursive: true });
  await copyFile(from, to);
}

/** Copies examples/ to `project` and returns its case ids, once the copy passes check. */
async function freshCopy(project: string): Promise<string[]> {
  await copyExamples(project);
  const baseline = await gradeCheck(project);
  if (!baseline.pass) {
    const why =
      baseline.error ?? baseline.issues.map((issue) => `${issue.file}:${issue.line} ${issue.ruleId}`).join(", ");
    throw new Error(
      `the copy of examples/ fails check before the agent ran (${why}); make check pass in examples/, then run the eval again`,
    );
  }
  const ids = await caseIds(project);
  if (typeof ids === "string") throw new Error(`plan fails on the copy of examples/: ${ids}`);
  return ids;
}

/** Checks a copy of examples/ once before any agent runs, so a broken copy or ticket costs no agent session. */
async function preflight(tickets: readonly Ticket[]): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), `${BRAND.name}-eval-`));
  try {
    const ids = await freshCopy(join(dir, "project"));
    for (const ticket of tickets) {
      if (ticket.case !== undefined && !ids.includes(ticket.case)) {
        throw new Error(`ticket ${ticket.file} extends ${ticket.case}, which examples/ does not have`);
      }
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/**
 * Whether `pid` is a process whose command line names the copy, as a run the MCP server started does. The agent can
 * write any supervisor.json, and its pid could name every process of the user, the harness's own group, or a number
 * the system gave to another process since.
 */
function isRunIn(project: string, pid: unknown): pid is number {
  if (typeof pid !== "number" || !Number.isSafeInteger(pid) || pid <= 1) return false;
  let command: string;
  try {
    command = execFileSync("ps", ["-ww", "-o", "command=", "-p", String(pid)], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
  } catch {
    // ps exits 1 when no such process is left
    return false;
  }
  return command.includes(project);
}

/** Stops the runs the agent started; each leads its own process group and outlives the agent. */
async function stopLeftoverRuns(project: string): Promise<void> {
  const runs = join(project, "runs");
  if (!existsSync(runs)) return;
  for (const id of await readdir(runs)) {
    let record: { pid?: unknown; exit?: unknown };
    try {
      record = JSON.parse(await readFile(join(runs, id, "supervisor.json"), "utf8")) as typeof record;
    } catch {
      continue;
    }
    // the MCP server adds exit once it saw the run end
    if (record.exit === undefined && isRunIn(project, record.pid)) await stopGroup(record.pid);
  }
}

/** Every file in the copy that Node could run as a plugin or hook, by its path, with a hash of its content. */
async function codeFiles(project: string): Promise<Map<string, string>> {
  const files = new Map<string, string>();
  for (const entry of await readdir(project, { recursive: true, withFileTypes: true })) {
    if (entry.isDirectory() || (entry.isFile() && DATA_EXTENSIONS.has(extname(entry.name)))) continue;
    const path = join(entry.parentPath, entry.name);
    // a symlink can give code a data name, so only a regular file counts by its content
    const content = entry.isFile()
      ? createHash("sha256")
          .update(await readFile(path))
          .digest("hex")
      : "not a file";
    files.set(relative(project, path), content);
  }
  return files;
}

/**
 * The keys of `CODE_KEYS` whose values differ between the baseline and the config the agent left, or why that config
 * cannot be compared: it is missing or unreadable, or it does not parse.
 */
async function changedConfigKeys(project: string, baseline: unknown): Promise<string[]> {
  let text: string;
  try {
    text = await readFile(join(project, BRAND.configFile), "utf8");
  } catch (error) {
    return [(error as NodeJS.ErrnoException).code === "ENOENT" ? "missing" : "unreadable"];
  }
  let drafted: unknown;
  try {
    drafted = parseYaml(text);
  } catch {
    return ["does not parse"];
  }
  return CODE_KEYS.filter((key) => !isDeepStrictEqual(configKey(baseline, key), configKey(drafted, key)));
}

/** A document that parses to null or a scalar has none of the keys. */
function configKey(document: unknown, key: string): unknown {
  return typeof document === "object" && document !== null ? (document as Record<string, unknown>)[key] : undefined;
}

/** The steps and checks of each case by id, to tell a drafted case from one that only gained a link. */
async function caseBodies(project: string): Promise<Map<string, string>> {
  const bodies = new Map<string, string>();
  const root = join(project, "cases");
  const files = existsSync(root) ? await readdir(root, { recursive: true }) : [];
  for (const file of files.filter((name) => name.endsWith(".yaml")).sort()) {
    let document: unknown;
    try {
      document = parseYaml(await readFile(join(root, file), "utf8"));
    } catch {
      // check reports the file
      continue;
    }
    const cases = (document as { cases?: unknown } | null)?.cases;
    if (!Array.isArray(cases)) continue;
    for (const item of cases as unknown[]) {
      const { id, steps = [], checks = [] } = (item ?? {}) as { id?: unknown; steps?: unknown; checks?: unknown };
      if (typeof id === "string" && !bodies.has(id)) bodies.set(id, JSON.stringify([steps, checks]));
    }
  }
  return bodies;
}

async function gradeCheck(project: string): Promise<CheckGrade> {
  interface CheckOutput {
    issues: { ruleId: string; severity: string; file: string; line: number }[];
    errors: number;
    warnings: number;
  }
  const exited = await cli(project, ["check", "--json"]);
  const output = outputOf<CheckOutput>(exited, "issues");
  if (typeof output === "string") return { pass: false, errors: 0, warnings: 0, issues: [], error: output };
  const issues = output.issues
    .filter((issue) => issue.severity === "error")
    .map(({ ruleId, file, line }) => ({ ruleId, file, line }));
  return { pass: exited.code === 0 && output.errors === 0, errors: output.errors, warnings: output.warnings, issues };
}

/** Every case id the project plans, of any stage that runs. */
async function caseIds(project: string): Promise<string[] | string> {
  const output = outputOf<{ cases: { caseId: string }[] }>(
    await cli(project, ["plan", "--env", ENV, "--json"]),
    "cases",
  );
  return typeof output === "string" ? output : [...new Set(output.cases.map((planned) => planned.caseId))].sort();
}

function gradeIds(ticket: Ticket, before: readonly string[], after: string[] | string): IdsGrade {
  const graded = ticket.kind === "extend";
  // a draft that leaves the project unloadable has unknown ids, which fails an extend ticket
  if (typeof after === "string") return { pass: graded ? false : null, added: [], error: after };
  const added = after.filter((id) => !before.includes(id));
  return { pass: graded ? added.length === 0 : null, added };
}

async function answerPrompts(runDir: string, answered: Set<string>, counts: Record<Ask, number>): Promise<void> {
  let names: string[];
  try {
    names = await readdir(join(runDir, "prompts"));
  } catch {
    return;
  }
  for (const name of names) {
    const id = /^([A-Za-z0-9][A-Za-z0-9._-]*)\.json$/.exec(name)?.[1];
    if (id === undefined || answered.has(id)) continue;
    let ask: unknown;
    try {
      ({ ask } = JSON.parse(await readFile(join(runDir, "prompts", name), "utf8")) as { ask?: unknown });
    } catch {
      // the run moved the prompt to done/ in the meantime
      continue;
    }
    if (typeof ask !== "string" || !Object.hasOwn(ANSWERS, ask)) continue;
    const answer = join(runDir, "answers", `${id}.json`);
    const temporary = `${answer}.${randomUUID()}.tmp`;
    await mkdir(dirname(answer), { recursive: true });
    await writeFile(temporary, JSON.stringify(ANSWERS[ask as Ask]));
    // the run claims an answer file by renaming it, so it must never see one half written
    await rename(temporary, answer);
    answered.add(id);
    counts[ask as Ask] += 1;
  }
}

/**
 * Runs the cases that link the ticket, answering each person prompt from ANSWERS. `drafted` holds the ids of
 * the cases that are new or have new steps or checks: a run of cases the agent only linked tests none of the ticket.
 */
async function gradeRun(project: string, ticket: Ticket, drafted: ReadonlySet<string>): Promise<RunGrade> {
  interface RunOutput {
    counts: Record<string, number>;
    cases: CaseLine[];
  }
  const args = ["run", "--env", ENV, "--link", `${TRACKER}:${ticket.key}`, "--channel", "answers-file"];
  const running = cli(project, [...args, "--run", GRADED_RUN_ID, "--json"], RUN_TIMEOUT_MS);
  // the race below takes the rejection of a stopped eval; this keeps it from counting as unhandled before then
  void running.catch(() => undefined);
  const runDir = join(project, "runs", GRADED_RUN_ID);
  const prompts: Record<Ask, number> = { verdict: 0, action: 0, value: 0 };
  const answered = new Set<string>();
  let exited: Exited | undefined;
  while (exited === undefined) {
    await answerPrompts(runDir, answered, prompts);
    exited = await Promise.race([running, sleep(POLL_MS, undefined)]);
  }
  const output = outputOf<RunOutput>(exited, "counts");
  const grade = { exit: exited.code, timedOut: exited.timedOut, prompts };
  if (typeof output === "string") return { ...grade, pass: false, drafted: [], error: output };
  const cases = output.cases.map(({ caseId, target, status, reason }) => ({
    caseId,
    target,
    status,
    ...(reason === undefined ? {} : { reason }),
  }));
  const ran = [...new Set(cases.map((line) => line.caseId))].filter((id) => drafted.has(id));
  const pass = exited.code === 0 && ran.length > 0;
  const error = exited.code === 0 && !pass ? { error: "no case it ran is new or has new steps or checks" } : {};
  return { ...grade, pass, counts: output.counts, cases, drafted: ran, ...error };
}

/** The model ids from the agent's JSON output: the keys of `modelUsage`, or `model`. */
function modelsOf(stdout: string): string[] {
  const text = stdout.trim();
  // a streaming agent ends with its result line
  for (const candidate of [text, text.slice(text.lastIndexOf("\n") + 1)]) {
    let json: unknown;
    try {
      json = JSON.parse(candidate);
    } catch {
      continue;
    }
    if (typeof json !== "object" || json === null) continue;
    if ("modelUsage" in json && typeof json.modelUsage === "object" && json.modelUsage !== null) {
      const models = Object.keys(json.modelUsage);
      if (models.length > 0) return models;
    }
    if ("model" in json && typeof json.model === "string" && json.model !== "") return [json.model];
  }
  return ["unknown"];
}

async function runAgent(command: string, dir: string, project: string, ticket: Ticket): Promise<AgentRecord> {
  const ticketFile = join(dir, "ticket.md");
  const mcpConfig = join(dir, "mcp.json");
  await writeFile(ticketFile, `${ticket.body}\n`);
  const server = { command: process.execPath, args: ["--conditions=development", CLI, "mcp", "--root", project] };
  await writeFile(mcpConfig, `${JSON.stringify({ mcpServers: { [BRAND.mcpServerName]: server } }, null, 2)}\n`);
  const exited = await runGroup("sh", ["-c", command], {
    cwd: project,
    timeoutMs: AGENT_TIMEOUT_MS,
    input: agentPrompt(ticket),
    stderr: "inherit",
    env: { ...process.env, EVAL_TICKET_FILE: ticketFile, EVAL_SKILL_FILE: SKILL, EVAL_MCP_CONFIG: mcpConfig },
  });
  const { code: exit, signal, timedOut, seconds } = exited;
  return { exit, signal, timedOut, seconds, models: modelsOf(exited.stdout) };
}

/**
 * The grades of a draft the harness does not load, because the agent added or changed files Node could run or config
 * keys that start processes.
 */
function refused(agent: AgentRecord, ticket: Ticket, changes: readonly string[]): Attempt {
  const error =
    "the agent added or changed files Node could run or config keys that start processes, which the harness never " +
    `loads: ${changes.join(", ")}`;
  return {
    agent,
    check: { pass: false, errors: 0, warnings: 0, issues: [], error },
    run: { pass: false, exit: null, timedOut: false, drafted: [], error, prompts: { verdict: 0, action: 0, value: 0 } },
    ids: { pass: ticket.kind === "extend" ? false : null, added: [], error },
  };
}

/** One agent session on a fresh copy of examples/, then the three grades. */
async function attempt(command: string, ticket: Ticket): Promise<Attempt> {
  // under the system temp dir, so the copy sits outside any git repository as a fresh clone would
  const dir = await mkdtemp(join(tmpdir(), `${BRAND.name}-eval-`));
  const project = join(dir, "project");
  try {
    const before = await freshCopy(project);
    const bodies = await caseBodies(project);
    const code = await codeFiles(project);
    // freshCopy ran check on this config, so it parses
    const config = parseYaml(await readFile(join(project, BRAND.configFile), "utf8"));
    const agent = await runAgent(command, dir, project, ticket);
    await stopLeftoverRuns(project);
    // the CLI imports a project's plugins and hooks and starts its process plugins and runners, so the harness never
    // opens a copy with code or code keys the agent wrote
    const changed = [...(await codeFiles(project))]
      .filter(([path, hash]) => code.get(path) !== hash)
      .map(([path]) => path)
      .sort();
    const keys = await changedConfigKeys(project, config);
    if (keys.length > 0) changed.push(`${BRAND.configFile} (${keys.join(", ")})`);
    if (changed.length > 0) return refused(agent, ticket, changed);
    const check = await gradeCheck(project);
    const ids = gradeIds(ticket, before, await caseIds(project));
    const after = await caseBodies(project);
    const drafted = new Set([...after].filter(([id, body]) => bodies.get(id) !== body).map(([id]) => id));
    const run = await gradeRun(project, ticket, drafted);
    return { agent, check, run, ids };
  } finally {
    try {
      await stopLeftoverRuns(project);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }
}

function rateOf(results: readonly (boolean | null)[]): Rate | null {
  const graded = results.filter((result) => result !== null);
  if (graded.length === 0) return null;
  const passed = graded.filter((result) => result).length;
  return { passed, graded: graded.length, rate: Math.round((passed / graded.length) * 100) / 100 };
}

function ratesOf(attempts: readonly Attempt[]): Record<"check" | "run" | "ids", Rate | null> {
  return {
    check: rateOf(attempts.map((one) => one.check.pass)),
    run: rateOf(attempts.map((one) => one.run.pass)),
    ids: rateOf(attempts.map((one) => one.ids.pass)),
  };
}

function progressLine(ticket: Ticket, n: number, repeats: number, { agent, check, run, ids }: Attempt): string {
  const word = (pass: boolean | null): string => (pass === null ? "not graded" : pass ? "pass" : "fail");
  const ran = run.error === undefined ? word(run.pass) : `${word(run.pass)} (${run.error})`;
  const agentEnd = agent.timedOut ? "timed out" : `exit ${agent.exit ?? agent.signal}`;
  return `${ticket.key} (${ticket.kind}) ${n}/${repeats}: agent ${agentEnd} after ${agent.seconds}s, check ${word(check.pass)}, run ${ran}, ids ${word(ids.pass)}`;
}

/** The skill's git blob hash, which changes with any edit, committed or not, and the last commit to touch it. */
function skillVersion(): { path: string; blob: string; commit: string | null; uncommitted: boolean } {
  const path = relative(REPO, SKILL);
  const git = (...args: string[]): string | null => {
    try {
      return (
        execFileSync("git", args, { cwd: REPO, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim() || null
      );
    } catch {
      return null;
    }
  };
  const blob = git("hash-object", path);
  if (blob === null) throw new Error(`git cannot hash ${path}`);
  const committed = git("rev-parse", "--verify", "--quiet", `HEAD:${path}`);
  return { path, blob, commit: git("log", "-1", "--format=%H", "--", path), uncommitted: blob !== committed };
}

async function demoIsUp(): Promise<void> {
  for (const url of DEMO_PROBES) {
    const up = await fetch(url, { signal: AbortSignal.timeout(5_000) }).then(
      async (response) => {
        await response.body?.cancel();
        return response.ok;
      },
      () => false,
    );
    if (!up) {
      throw new Error(
        `${url} does not answer or answers with an error; start the demo: docker compose -f examples/demo-app/docker-compose.yml up -d`,
      );
    }
  }
}

function repeatsOf(value: string | undefined): number {
  if (value === undefined || value === "") return 3;
  const repeats = Number(value);
  if (!/^\d+$/.test(value) || repeats < 1)
    throw new Error(`EVAL_REPEATS takes a whole number of at least 1, not "${value}"`);
  return repeats;
}

/** The command with the value of each `NAME=value` assignment masked, since a key may sit inline in it. */
function maskedCommand(command: string): string {
  return command.replaceAll(/(^|\s)([A-Za-z_][A-Za-z0-9_]*)=('[^']*'|"[^"]*"|\S+)/g, "$1$2=***");
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function main(): Promise<void> {
  const repeats = repeatsOf(process.env.EVAL_REPEATS);
  const command = process.env.EVAL_AGENT_CMD?.trim() || DEFAULT_AGENT_CMD;
  const tickets = await loadTickets();
  const skill = skillVersion();
  const { version } = JSON.parse(await readFile(join(REPO, "packages", "cli", "package.json"), "utf8")) as {
    version: string;
  };
  await demoIsUp();
  await preflight(tickets);
  const startedAt = new Date();
  const done: { ticket: Ticket; attempts: Attempt[] }[] = [];
  let failure: { error: unknown } | undefined;
  try {
    for (const ticket of tickets) {
      const attempts: Attempt[] = [];
      done.push({ ticket, attempts });
      for (let n = 1; n <= repeats; n++) {
        const one = await attempt(command, ticket);
        console.error(progressLine(ticket, n, repeats, one));
        attempts.push(one);
      }
    }
  } catch (error) {
    failure = { error: stopping.signal.aborted ? stopping.signal.reason : error };
  }
  const all = done.flatMap(({ attempts }) => attempts);
  // an eval that stops early still writes the attempts it finished, so no agent session is lost
  if (all.length > 0) {
    const report = {
      startedAt: startedAt.toISOString(),
      finishedAt: new Date().toISOString(),
      ...(failure === undefined ? {} : { stopped: messageOf(failure.error) }),
      agentCommand: maskedCommand(command),
      models: [...new Set(all.flatMap((one) => one.agent.models))].sort(),
      skill,
      packageVersion: version,
      env: ENV,
      repeats,
      agentTimeoutSeconds: AGENT_TIMEOUT_MS / 1000,
      personPrompts: PERSON_NOTE,
      grades: ratesOf(all),
      tickets: done
        .filter(({ attempts }) => attempts.length > 0)
        .map(({ ticket, attempts }) => ({
          key: ticket.key,
          file: ticket.file,
          kind: ticket.kind,
          ...(ticket.case === undefined ? {} : { case: ticket.case }),
          grades: ratesOf(attempts),
          attempts,
        })),
    };
    await mkdir(RESULTS, { recursive: true });
    // no colons, which some file systems refuse in a name
    const file = join(
      RESULTS,
      `${startedAt
        .toISOString()
        .replace(/\.\d+Z$/, "Z")
        .replaceAll(":", "")}.json`,
    );
    await writeFile(file, `${JSON.stringify(report, null, 2)}\n`);
    console.log(file);
  }
  if (failure !== undefined) throw failure.error;
}

// a second signal of the same kind finds no handler and ends the harness at once
for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"] as const) {
  process.once(signal, () => {
    stoppedBy ??= signal;
    stopping.abort(new Error(`stopped by ${signal}`));
  });
}

// 0 when every attempt finished, whatever the grades; 2 when the harness itself fails; 128 plus the signal number
// when a signal stopped it. A failed or stopped run still writes the result file if at least one attempt finished.
try {
  await main();
} catch (error) {
  console.error(`eval: ${messageOf(error)}`);
  process.exitCode = stoppedBy === undefined ? 2 : 128 + constants.signals[stoppedBy];
}
