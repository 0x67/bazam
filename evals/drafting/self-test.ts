/**
 * The harness self-test. With the demo app running, from the repository root:
 *
 *   node evals/drafting/self-test.ts
 *
 * No model runs. It runs the eval three times, with one attempt per ticket:
 *
 * 1. With the default agent command. A `claude` stub first on PATH starts this file as the agent, which checks the
 *    command's flags and the agent contract, drafts by ticket key (see actAsAgent), and prints a result with
 *    `modelUsage` as `claude -p` does. The grades must match, and the eval must stop the run the agent left behind
 *    before it grades, leave alone the processes other run records name, never load the plugin the agent wrote, and
 *    refuse the draft that adds a process plugin entry to the config, so that plugin never starts.
 * 2. With EVAL_AGENT_CMD set, stopped with SIGINT while the agent works on DEMO-502. The agent and the copy must be
 *    gone, and the result file must hold the DEMO-501 attempt with the inline key masked.
 * 3. With a ticket that extends a case examples/ does not have, which must stop the eval before any agent starts.
 *
 * It deletes each result file once its checks hold; on a failure it keeps the file and names it.
 */
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import { existsSync } from "node:fs";
import {
  appendFile,
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { text } from "node:stream/consumers";
import { setTimeout as sleep } from "node:timers/promises";
import { BRAND } from "../../packages/core/src/brand.ts";

const REPO = join(import.meta.dirname, "..", "..");
const RUN = join(import.meta.dirname, "run.ts");
const TICKETS = join(import.meta.dirname, "tickets");

const GOOD = "DEMO-506";
const BROKEN = "DEMO-505";
const BROKEN_ID = "AUTH-SESSION-099";
// the agent only links an existing case, in the first run, and works until it is stopped, in the second
const LINK_ONLY = "DEMO-502";
const LINKED_ID = "API-KEY-001";
const PLUGIN = "DEMO-503";
// the agent adds a process plugin entry to the config, which starts its command once anything loads the copy
const CONFIG_PLUGIN = "DEMO-504";
const STUB_MODEL = "stub-agent";
const CLAUDE_MODELS = ["stub-model-large", "stub-model-small"];
const FAKE_KEY = "fake-key-for-self-test";

// the self-test's scratch folder, shared with the agent through the eval's environment
const SCRATCH = "EVAL_SELF_TEST_DIR";
const LEFTOVER_PID = "leftover.pid";
const LEFTOVER_STOPPED = "leftover.stopped";
const DECOY_PID = "decoy.pid";
const PLUGIN_MARK = "plugin.imported";
const CONFIG_PLUGIN_MARK = "config-plugin.started";
const WORKING = "working";

// a run the agent started: it writes "running" to its file once it listens for SIGTERM, then records there whether
// the eval stopped it before the graded run began
const LEFTOVER = `
const { existsSync, writeFileSync } = require("node:fs");
process.on("SIGTERM", () => {
  writeFileSync(process.argv[1], existsSync("runs/eval-graded") ? "while grading" : "before grading");
  process.exit(0);
});
writeFileSync(process.argv[1], "running");
setInterval(() => undefined, 1000);
`;

const GOOD_CASE = [
  "cases:",
  "  - id: PROFILE-FLAGS-001",
  "    title: Customer sees a flag for each country in the searchable country list",
  "    stage: acceptance",
  "    risk: low",
  `    links: [jira:${GOOD}]`,
  "    targets: [web]",
  "    tags: [profile]",
  "    steps:",
  "      - open: ${env.APP_URL}/profile/phone",
  "        as: customer",
  "      - screenshot: { name: phone-countries }",
  "        as: customer",
  "      - guided:",
  "          title: Confirm the country flags look right",
  "          steps:",
  "            - On the Phone number page, click the searchable country field.",
  "            - Look at the flag before each calling code in the list.",
  "          expected: The United Kingdom, Indonesia and the United States each show a flag picture.",
  "          observe:",
  "            api:",
  "              request: GET ${env.APP_URL}/api/session/me",
  "              status: 200",
  '              body: { email: "${identity.customer.email}" }',
  "        as: customer",
  "",
].join("\n");

// AUTH-SESSION-001 covers this behavior, and the case checks nothing
const BROKEN_CASE = [
  "cases:",
  `  - id: ${BROKEN_ID}`,
  "    title: A visitor without a session sees no account",
  "    stage: acceptance",
  "    risk: medium",
  `    links: [jira:${BROKEN}]`,
  "    targets: [web]",
  "    tags: [session]",
  "    steps:",
  "      - open: ${env.APP_URL}/dashboard",
  "",
].join("\n");

// the config file's name as a regular expression
const CONFIG_FILE = BRAND.configFile.replaceAll(".", "\\.");

const quote = (value: string): string => `'${value.replaceAll("'", `'\\''`)}'`;

async function actAsAgent(ticketFile: string, args: readonly string[]): Promise<void> {
  const prompt = await text(process.stdin);
  const ticket = await readFile(ticketFile, "utf8");
  assert.ok(prompt.includes(ticket.trim()), "the prompt on stdin holds the ticket");
  assert.ok(!ticket.startsWith("---"), "the agent never sees the ticket's front matter");
  const config = JSON.parse(await readFile(process.env.EVAL_MCP_CONFIG ?? "", "utf8")) as {
    mcpServers?: Record<string, { args?: string[] }>;
  };
  const serverArgs = config.mcpServers?.[BRAND.mcpServerName]?.args ?? [];
  assert.ok(serverArgs.includes("mcp"), "the MCP config starts the server");
  const skill = await readFile(process.env.EVAL_SKILL_FILE ?? "", "utf8");
  assert.match(
    skill,
    new RegExp(`^name: ${BRAND.skillName}$`, "m"),
    "EVAL_SKILL_FILE is the authoring skill",
  );
  assert.ok(existsSync(BRAND.configFile), "the agent starts in the copy of the example project");
  const scratch = process.env[SCRATCH];
  assert.ok(scratch !== undefined, `${SCRATCH} reaches the agent`);
  const key = /^# ([A-Z][A-Z0-9]*-\d+):/m.exec(ticket)?.[1];
  // started with arguments, this file stands in for claude under the default agent command
  if (args.length === 0) {
    if (key === LINK_ONLY) await keepWorking(scratch);
    console.log(JSON.stringify({ model: STUB_MODEL }));
    return;
  }
  checkDefaultFlags(args, skill);
  if (key === GOOD) {
    await writeFile(join("cases", "profile", "flags.yaml"), GOOD_CASE);
    await leaveRunsBehind(scratch, serverArgs[serverArgs.indexOf("--root") + 1] ?? "");
  }
  if (key === BROKEN) await writeFile(join("cases", "auth", "no-session.yaml"), BROKEN_CASE);
  if (key === LINK_ONLY) await linkOnly(key);
  if (key === PLUGIN) await addPlugin(scratch);
  if (key === CONFIG_PLUGIN) await addConfigPlugin(scratch);
  const modelUsage = Object.fromEntries(
    CLAUDE_MODELS.map((model) => [model, { inputTokens: 1, outputTokens: 1 }]),
  );
  console.log(
    JSON.stringify({
      type: "result",
      subtype: "success",
      is_error: false,
      result: "drafted",
      modelUsage,
    }),
  );
}

/** The flags of the default agent command, as claude gets them once the shell expanded them. */
function checkDefaultFlags(args: readonly string[], skill: string): void {
  const valueOf = (flag: string): string | undefined => {
    const at = args.indexOf(flag);
    return at === -1 ? undefined : args[at + 1];
  };
  assert.equal(args[0], "-p");
  assert.ok(
    args.includes("--restricted"),
    "the agent runs restricted: no tools that run code, no user settings",
  );
  assert.equal(
    valueOf("--tools"),
    "Read,Glob,Grep,Edit,Write",
    "the agent has the file tools and no other",
  );
  assert.equal(valueOf("--permission-mode"), "dontAsk", "anything not allowed is denied");
  assert.equal(valueOf("--mcp-config"), process.env.EVAL_MCP_CONFIG);
  assert.ok(args.includes("--strict-mcp-config"));
  assert.equal(
    valueOf("--append-system-prompt"),
    skill.replace(/\n+$/, ""),
    "the skill is in the system prompt",
  );
  const allowed = args.slice(args.indexOf("--allowedTools") + 1);
  const until = allowed.findIndex((arg) => arg.startsWith("--"));
  assert.deepEqual(allowed.slice(0, until === -1 ? undefined : until), [
    `mcp__${BRAND.mcpServerName}__*`,
    "Read",
    "Glob",
    "Grep",
    "Edit",
    "Write",
  ]);
  const flags = args.filter((arg) => arg.startsWith("--"));
  assert.ok(
    !flags.some((flag) => /dangerously|bypass/i.test(flag)),
    `no permission bypass: ${flags.join(" ")}`,
  );
}

/**
 * Leaves a run behind that leads its own group and names the copy, as one started through run_start does. Then two
 * run records the eval must not act on: a process of the self-test's that does not name the copy, and a pid that
 * process.kill refuses.
 */
async function leaveRunsBehind(scratch: string, root: string): Promise<void> {
  const stopped = join(scratch, LEFTOVER_STOPPED);
  const child = spawn(process.execPath, ["-e", LEFTOVER, stopped, `--root=${root}`], {
    detached: true,
    stdio: "ignore",
  });
  child.unref();
  // a SIGTERM that came before the handler would end it without a word
  for (let tries = 0; !existsSync(stopped); tries++) {
    assert.ok(tries < 100, "the leftover run started");
    await sleep(100);
  }
  const record = async (runId: string, pid: number): Promise<void> => {
    await mkdir(join("runs", runId), { recursive: true });
    await writeFile(join("runs", runId, "supervisor.json"), JSON.stringify({ runId, pid }));
  };
  await record("stub-leftover", child.pid!);
  await writeFile(join(scratch, LEFTOVER_PID), String(child.pid));
  await record("decoy", Number(await readFile(join(scratch, DECOY_PID), "utf8")));
  await record("bad-pid", 1.5);
}

/** Adds the ticket's link to a case that passes as it is but tests nothing the ticket asks for. */
async function linkOnly(key: string): Promise<void> {
  const file = join("cases", "api", "whoami.yaml");
  const source = await readFile(file, "utf8");
  const linked = source.replace("links: [jira:DEMO-201]", `links: [jira:DEMO-201, jira:${key}]`);
  assert.notEqual(linked, source, `${LINKED_ID} links DEMO-201`);
  await writeFile(file, linked);
}

/** A plugin that leaves a mark once something imports it. */
async function addPlugin(scratch: string): Promise<void> {
  const plugin = [
    'import { writeFileSync } from "node:fs";',
    `writeFileSync(${JSON.stringify(join(scratch, PLUGIN_MARK))}, "imported");`,
    'export default { name: "stub-plugin", apiVersion: 1 };',
    "",
  ];
  await writeFile("stub-plugin.ts", plugin.join("\n"));
  await appendFile(BRAND.configFile, "\nplugins: [./stub-plugin.ts]\n");
}

/** A process plugin entry that leaves a mark once it starts, run by `process.execPath` so it never fails to spawn. */
async function addConfigPlugin(scratch: string): Promise<void> {
  const script = `require("node:fs").writeFileSync(${JSON.stringify(join(scratch, CONFIG_PLUGIN_MARK))}, "started")`;
  // JSON is YAML flow syntax, so the command needs no quoting
  await appendFile(
    BRAND.configFile,
    `\nplugins: [{ command: ${JSON.stringify([process.execPath, "-e", script])} }]\n`,
  );
}

/** Says where it works, then works until the eval stops it. */
async function keepWorking(scratch: string): Promise<void> {
  const file = join(scratch, WORKING);
  await writeFile(`${file}.tmp`, `${process.pid}\n${process.cwd()}`);
  await rename(`${file}.tmp`, file);
  await new Promise<never>(() => setInterval(() => undefined, 1_000));
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function hasEnded(pid: number): Promise<boolean> {
  for (let tries = 0; tries < 20; tries++) {
    if (!isAlive(pid)) return true;
    await sleep(100);
  }
  return false;
}

type Grade = "check" | "run" | "ids";

interface TicketResult {
  key: string;
  kind: string;
  grades: Record<Grade, { rate: number } | null>;
  attempts: {
    agent: { exit: number | null; models: string[] };
    check: { issues: { ruleId: string }[]; error?: string };
    run: {
      exit: number | null;
      cases?: { caseId: string; status: string }[];
      drafted: string[];
      prompts: Record<string, number>;
    };
    ids: { added: string[] };
  }[];
}

interface Report {
  stopped?: string;
  agentCommand: string;
  models: string[];
  skill: { blob: string };
  packageVersion: string;
  tickets: TicketResult[];
}

function rates(ticket: TicketResult): (number | null)[] {
  return (["check", "run", "ids"] as const).map((grade) => ticket.grades[grade]?.rate ?? null);
}

function checkReport(report: Report, version: string): void {
  assert.ok(report.agentCommand.startsWith("claude -p "), "the report names the default command");
  assert.deepEqual(report.models, CLAUDE_MODELS, "the model ids come from modelUsage");
  assert.match(report.skill.blob, /^[0-9a-f]{40}$/);
  assert.equal(report.packageVersion, version);
  assert.equal(report.stopped, undefined);
  const kinds = report.tickets.map((ticket) => ticket.kind);
  const count = (kind: string): number => kinds.filter((one) => one === kind).length;
  assert.ok(
    count("new") >= 3 && count("extend") >= 2 && count("guided") >= 1,
    `ticket kinds: ${kinds.join(", ")}`,
  );
  for (const ticket of report.tickets) {
    const [first] = ticket.attempts;
    assert.ok(first !== undefined, `${ticket.key} has an attempt`);
    assert.equal(first.agent.exit, 0, `the agent contract holds for ${ticket.key}`);
    if (ticket.key === GOOD) {
      assert.deepEqual(rates(ticket), [1, 1, null], ticket.key);
      assert.equal(first.run.prompts.verdict, 1, "the harness answered the guided step");
      assert.deepEqual(first.run.drafted, ["PROFILE-FLAGS-001"]);
    } else if (ticket.key === BROKEN) {
      assert.equal(rates(ticket)[0], 0, ticket.key);
      assert.ok(
        first.check.issues.some((issue) => issue.ruleId === "case-has-check"),
        "check names case-has-check",
      );
      assert.equal(rates(ticket)[2], 0, ticket.key);
      assert.deepEqual(first.ids.added, [BROKEN_ID]);
    } else if (ticket.key === LINK_ONLY) {
      // the linked case runs and passes, yet the draft tests nothing of the ticket
      assert.deepEqual(rates(ticket), [1, 0, null], ticket.key);
      assert.equal(first.run.exit, 0, `${LINKED_ID} passes`);
      assert.ok(
        first.run.cases?.some(({ caseId, status }) => caseId === LINKED_ID && status === "pass"),
      );
      assert.deepEqual(first.run.drafted, []);
    } else if (ticket.key === PLUGIN) {
      assert.deepEqual(rates(ticket), [0, 0, null], ticket.key);
      assert.match(
        first.check.error ?? "",
        new RegExp(`: stub-plugin\\.ts, ${CONFIG_FILE} \\(plugins\\)$`),
        "the grade names the file and the config key the harness refused",
      );
    } else if (ticket.key === CONFIG_PLUGIN) {
      assert.deepEqual(rates(ticket), [0, 0, 0], ticket.key);
      assert.match(
        first.check.error ?? "",
        new RegExp(`: ${CONFIG_FILE} \\(plugins\\)$`),
        "the grade names the config key the harness refused",
      );
    } else {
      // a ticket the stub leaves alone has no case that links it
      assert.deepEqual(rates(ticket), [1, 0, ticket.kind === "extend" ? 1 : null], ticket.key);
    }
  }
}

/** Runs `check` on the result file and deletes it once that holds; on a failure the file stays and is named. */
async function checked(
  file: string,
  check: (report: Report, source: string) => void,
): Promise<void> {
  const source = await readFile(file, "utf8");
  try {
    check(JSON.parse(source) as Report, source);
  } catch (error) {
    console.error(`self-test failed; the result file stays at ${file}`);
    throw error;
  }
  await rm(file);
}

function resultFile(stdout: string): string {
  const file = stdout.trim().split("\n").at(-1) ?? "";
  assert.ok(file.endsWith(".json"), `the eval names its result file: ${stdout}`);
  return file;
}

async function defaultCommandRun(scratch: string, version: string): Promise<void> {
  const bin = join(scratch, "bin");
  const stub = join(bin, "claude");
  await mkdir(bin);
  await writeFile(
    stub,
    `#!/bin/sh\nexec ${quote(process.execPath)} ${quote(import.meta.filename)} "$@"\n`,
    {
      mode: 0o755,
    },
  );
  const env = {
    ...process.env,
    PATH: `${bin}${delimiter}${process.env.PATH ?? ""}`,
    EVAL_AGENT_CMD: "",
    EVAL_TICKETS: "",
    EVAL_REPEATS: "1",
    [SCRATCH]: scratch,
  };
  // the default command starts claude; the real one must never start here
  const found = spawnSync("sh", ["-c", "command -v claude"], {
    env,
    encoding: "utf8",
  }).stdout.trim();
  assert.equal(found, stub, "the claude stub comes first on PATH");
  const finished = spawnSync(process.execPath, [RUN], {
    env,
    stdio: ["ignore", "pipe", "inherit"],
    encoding: "utf8",
  });
  const leftover = existsSync(join(scratch, LEFTOVER_PID))
    ? Number(await readFile(join(scratch, LEFTOVER_PID), "utf8"))
    : undefined;
  const ended = leftover === undefined || (await hasEnded(leftover));
  if (!ended) process.kill(-leftover, "SIGKILL");
  assert.equal(finished.status, 0, "the eval writes its result file");
  assert.ok(leftover !== undefined, `the agent left a run behind for ${GOOD}`);
  const file = resultFile(finished.stdout);
  const stopped = existsSync(join(scratch, LEFTOVER_STOPPED))
    ? await readFile(join(scratch, LEFTOVER_STOPPED), "utf8")
    : "never";
  const decoy = Number(await readFile(join(scratch, DECOY_PID), "utf8"));
  await checked(file, (report) => {
    assert.ok(
      !existsSync(join(scratch, PLUGIN_MARK)),
      "the eval never loaded the plugin the agent wrote",
    );
    assert.ok(
      !existsSync(join(scratch, CONFIG_PLUGIN_MARK)),
      "the eval never started the process plugin the agent added to the config",
    );
    checkReport(report, version);
    assert.equal(
      spawnSync("git", ["check-ignore", "-q", file], { cwd: REPO }).status,
      0,
      "git ignores the file",
    );
    assert.ok(ended, "the eval stopped the run the agent left behind");
    assert.equal(stopped, "before grading", "the eval stopped the run before it graded");
    assert.ok(
      isAlive(decoy),
      "the eval left alone a process whose command line does not name the copy",
    );
  });
}

async function interruptedRun(scratch: string): Promise<void> {
  const agentCommand = `EVAL_SELF_TEST_KEY=${FAKE_KEY} ${quote(process.execPath)} ${quote(import.meta.filename)}`;
  const env = {
    ...process.env,
    EVAL_AGENT_CMD: agentCommand,
    EVAL_TICKETS: "",
    EVAL_REPEATS: "1",
    [SCRATCH]: scratch,
  };
  const harness = spawn(process.execPath, [RUN], { env, stdio: ["ignore", "pipe", "inherit"] });
  const exited = once(harness, "exit") as Promise<[number | null, NodeJS.Signals | null]>;
  let stdout = "";
  harness.stdout.setEncoding("utf8").on("data", (chunk: string) => {
    stdout += chunk;
  });
  const working = join(scratch, WORKING);
  for (const end = Date.now() + 120_000; !existsSync(working); await sleep(100)) {
    if (Date.now() > end || harness.exitCode !== null) {
      harness.kill("SIGKILL");
      assert.fail(`the agent never started work on ${LINK_ONLY}`);
    }
  }
  const [pid = "", cwd = ""] = (await readFile(working, "utf8")).split("\n");
  // Ctrl-C reaches the foreground group, which holds the harness but none of the groups it started
  harness.kill("SIGINT");
  const timeout = setTimeout(() => harness.kill("SIGKILL"), 30_000);
  const [code, signal] = await exited;
  clearTimeout(timeout);
  const ended = await hasEnded(Number(pid));
  const copyLeft = existsSync(dirname(cwd));
  if (!ended) process.kill(Number(pid), "SIGKILL");
  await rm(dirname(cwd), { recursive: true, force: true });
  assert.deepEqual([code, signal], [130, null], "the harness cleans up after SIGINT and exits 130");
  assert.ok(ended, "the eval stopped the agent it waited on");
  assert.ok(!copyLeft, "the eval deleted the copy");
  await checked(resultFile(stdout), (report, source) => {
    assert.ok(!source.includes(FAKE_KEY), "the result file masks the key in the agent command");
    assert.equal(report.agentCommand, agentCommand.replace(FAKE_KEY, "***"));
    assert.deepEqual(report.models, [STUB_MODEL], "the model id comes from the top-level model");
    assert.match(report.stopped ?? "", /SIGINT/);
    assert.deepEqual(
      report.tickets.map((ticket) => [ticket.key, ticket.attempts.length]),
      [["DEMO-501", 1]],
      "the result file holds the attempt finished before the stop",
    );
  });
}

async function brokenTicketRun(scratch: string): Promise<void> {
  const tickets = join(scratch, "tickets");
  await mkdir(tickets);
  await copyFile(join(TICKETS, "501-sign-out.md"), join(tickets, "501-sign-out.md"));
  const extend = await readFile(join(TICKETS, "505-no-session.md"), "utf8");
  const typo = extend.replace("case: AUTH-SESSION-001", "case: AUTH-SESSION-01");
  assert.notEqual(typo, extend, "DEMO-505 extends AUTH-SESSION-001");
  await writeFile(join(tickets, "505-no-session.md"), typo);
  const sessions = join(scratch, "sessions");
  const finished = spawnSync(process.execPath, [RUN], {
    env: {
      ...process.env,
      EVAL_AGENT_CMD: `echo started >> ${quote(sessions)}`,
      EVAL_TICKETS: tickets,
      EVAL_REPEATS: "1",
    },
    stdio: ["ignore", "pipe", "pipe"],
    encoding: "utf8",
  });
  assert.equal(finished.status, 2, "a ticket that extends a missing case stops the eval");
  assert.match(finished.stderr, /extends AUTH-SESSION-01, which examples\/ does not have/);
  assert.ok(!existsSync(sessions), "no agent started before the eval found the ticket");
  assert.equal(finished.stdout, "", "no result file without an attempt");
}

async function selfTest(): Promise<void> {
  const { version } = JSON.parse(
    await readFile(join(REPO, "packages", "cli", "package.json"), "utf8"),
  ) as {
    version: string;
  };
  const scratch = await mkdtemp(join(tmpdir(), `${BRAND.name}-self-test-`));
  // a process with its own group that has nothing to do with any copy
  const decoy = spawn(process.execPath, ["-e", "setInterval(() => undefined, 1000)"], {
    detached: true,
    stdio: "ignore",
  });
  decoy.unref();
  try {
    await writeFile(join(scratch, DECOY_PID), String(decoy.pid));
    await defaultCommandRun(scratch, version);
    await interruptedRun(scratch);
    await brokenTicketRun(scratch);
  } finally {
    if (isAlive(decoy.pid!)) process.kill(-decoy.pid!, "SIGKILL");
    await rm(scratch, { recursive: true, force: true });
  }
  console.log("self-test passed: the grades, the stop on SIGINT and the ticket check hold");
}

const ticketFile = process.env.EVAL_TICKET_FILE;
await (ticketFile === undefined ? selfTest() : actAsAgent(ticketFile, process.argv.slice(2)));
