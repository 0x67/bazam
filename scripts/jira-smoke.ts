import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { parseArgs } from "node:util";
import { BRAND } from "../packages/core/src/brand.ts";

// posts to a real Jira site and is run by hand, never in CI; brand.ts imports nothing, so this process loads
// no workspace package and runs the CLI from sources as a child

const repoRoot = path.resolve(import.meta.dirname, "..");
const cliMain = path.join(repoRoot, "packages", "cli", "src", "main.ts");
const defaultInputsFile = path.join(import.meta.dirname, ".jira-smoke.env");
const USAGE = "usage: node scripts/jira-smoke.ts [--dry-run] [--keep] [--inputs <file>]";

const INPUT_NAMES = [
  "JIRA_SMOKE_SITE",
  "JIRA_SMOKE_PROJECT",
  "JIRA_SMOKE_TICKET",
  "JIRA_SMOKE_API",
  "JIRA_SMOKE_ISSUE_TYPE",
  "JIRA_SMOKE_LINK_TYPE",
];
// also the secret names the written config gives the CLI, which reads them from its environment
const CREDENTIAL_NAMES = ["JIRA_EMAIL", "JIRA_API_TOKEN"];

const ISSUE_KEY = /^([A-Z][A-Z0-9_]*)-[1-9][0-9]*$/;
const PROJECT_KEY = /^[A-Z][A-Z0-9_]*$/;
const SITE_HOST = /^[a-z0-9-]+(\.[a-z0-9-]+)*(:[0-9]+)?$/;
const COMMENT_ID = /^[0-9]+$/;
const LOOPBACK_HOSTS: ReadonlySet<string> = new Set(["127.0.0.1", "localhost"]);
// mirrors connect in packages/tracker-jira/src/client.ts, so no request goes where the CLI would refuse
const SCOPED_API = /^https:\/\/api\.atlassian\.com\/ex\/jira\/[^/?#]+\/?$/;

const SEARCH_LIMIT_MS = 60_000;
const SEARCH_PAUSE_MS = 2_000;
const REQUEST_TIMEOUT_MS = 30_000;

const ENV = "smoke";
const TARGET = "smoke";
const FAIL_RUN = "smoke-fail";
const PASS_RUN = "smoke-pass";
const SMOKE_LABEL = `${BRAND.markerPrefix}-smoke`;
const PROBE_TITLE = "Folded section";
const PROBE: unknown = {
  type: "doc",
  version: 1,
  content: [
    {
      type: "paragraph",
      content: [
        { type: "text", text: "Smoke probe: the section below should show folded until opened." },
      ],
    },
    {
      type: "expand",
      attrs: { title: PROBE_TITLE },
      content: [
        {
          type: "paragraph",
          content: [{ type: "text", text: "This paragraph sits inside an expand node." }],
        },
      ],
    },
  ],
};

/** Exit 2: the run stopped before anything was posted. */
class CouldNotStart extends Error {}

/** A Jira answer outside 2xx. */
class JiraAnswer extends Error {
  readonly status: number;

  constructor(message: string, status: number) {
    super(message);
    this.status = status;
  }
}

// a network failure, a timeout, a 429 or a 5xx may pass on the next try; any other answer will not
function mayPass(error: unknown): boolean {
  return !(error instanceof JiraAnswer) || error.status === 429 || error.status >= 500;
}

interface Inputs {
  site: string;
  project: string;
  ticket: string;
  api: string | undefined;
  issueType: string;
  linkType: string;
}

interface Credentials {
  email: string;
  token: string;
}

interface CliRun {
  code: number | null;
  stdout: string;
  stderr: string;
}

interface ItemOutcome {
  ok: boolean;
  ticket: { key: string };
  url?: string;
  error?: string;
}

interface BugOutcome {
  caseId: string;
  ok: boolean;
  action: string;
  key?: string;
  url?: string;
  error?: string;
}

/** What `report post --json` prints, with the CLI's exit code. */
interface PostOutput {
  code: number | null;
  items: ItemOutcome[];
  bugs: BugOutcome[];
}

/** Masks the credentials in everything the script prints. */
class Output {
  readonly #secrets: string[] = [];

  hide(...values: string[]): void {
    this.#secrets.push(...values.filter((value) => value !== ""));
    this.#secrets.sort((a, b) => b.length - a.length);
  }

  mask(text: string): string {
    return this.#secrets.reduce((masked, secret) => masked.replaceAll(secret, "[redacted]"), text);
  }

  line(text: string): void {
    console.log(this.mask(text));
  }

  error(text: string): void {
    console.error(this.mask(text));
  }
}

/** The temporary project, the CLI's environment and what the run has created so far. */
interface Smoke {
  out: Output;
  inputs: Inputs;
  root: string;
  caseId: string;
  env: NodeJS.ProcessEnv;
  /** Aborted by Ctrl-C. */
  signal: AbortSignal;
  ticketComment?: string;
  bug?: { key: string; url: string };
  /** The label of a bug the run may have filed but could not name. */
  possibleBugLabel?: string;
}

/** The search result: the key it waited for, with how long that took and the last failed try. */
interface Search {
  key: string | undefined;
  elapsed: number;
  failed: Error | undefined;
}

/** The git-ignored default, or a file outside the repository, where git cannot add the credentials. */
async function inputsFile(given: string | undefined): Promise<string> {
  if (given === undefined) return defaultInputsFile;
  const file = path.resolve(given);
  // a symlink, such as /tmp on macOS, can reach the repository under another path
  const real = await realpath(file).catch(() => file);
  const inRepo = [file, real].some((candidate) => {
    const relative = path.relative(repoRoot, candidate);
    return relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
  });
  if (inRepo && file !== defaultInputsFile && real !== defaultInputsFile)
    throw new CouldNotStart(
      `--inputs ${given} is inside the repository, where git does not ignore it; use ${path.relative(process.cwd(), defaultInputsFile)} or a file outside the repository`,
    );
  return file;
}

/** `KEY=VALUE` lines of the wanted names; blank lines and `#` comments are skipped, a missing file is empty. */
async function readInputsFile(
  file: string,
  wanted: readonly string[],
): Promise<Map<string, string>> {
  let text: string;
  try {
    text = await readFile(file, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return new Map();
    throw new CouldNotStart(`cannot read ${file}: ${(error as Error).message}`);
  }
  const values = new Map<string, string>();
  text.split(/\r?\n/).forEach((raw, index) => {
    const line = raw.trim();
    if (line === "" || line.startsWith("#")) return;
    const equals = line.indexOf("=");
    // the line may hold a credential, so the message names only its number
    if (equals <= 0) throw new CouldNotStart(`${file}:${index + 1} is not a KEY=VALUE line`);
    const name = line.slice(0, equals).trim();
    const value = line.slice(equals + 1).trim();
    if (wanted.includes(name))
      values.set(name, /^(["']).*\1$/.test(value) ? value.slice(1, -1) : value);
  });
  return values;
}

/** The inputs, from the environment first and then the file; a dry run reads no credential, not even from the file. */
async function loadInputs(
  file: string,
  dryRun: boolean,
): Promise<{ inputs: Inputs; credentials: Credentials | undefined }> {
  const values = await readInputsFile(file, [...INPUT_NAMES, ...(dryRun ? [] : CREDENTIAL_NAMES)]);
  const get = (name: string): string | undefined => {
    const set = process.env[name];
    return set !== undefined && set !== "" ? set : values.get(name) || undefined;
  };
  const missing: string[] = [];
  const required = (name: string, example?: string): string => {
    const value = get(name) ?? (dryRun ? example : undefined);
    if (value === undefined) missing.push(name);
    return value ?? "";
  };
  const site = required("JIRA_SMOKE_SITE", "example.atlassian.net");
  const project = required("JIRA_SMOKE_PROJECT", "DEMO");
  const ticket = required("JIRA_SMOKE_TICKET", "DEMO-1");
  const credentials = dryRun
    ? undefined
    : { email: required("JIRA_EMAIL"), token: required("JIRA_API_TOKEN") };
  if (missing.length > 0)
    throw new CouldNotStart(`set ${missing.join(", ")} in the environment or in ${file}`);

  // mirrors isSiteHost in packages/core/src/project.ts, so the CLI accepts any site that passes here
  if (
    !SITE_HOST.test(site) ||
    !URL.canParse(`https://${site}`) ||
    new URL(`https://${site}`).host !== site
  )
    throw new CouldNotStart(`JIRA_SMOKE_SITE ${site} is not a host such as example.atlassian.net`);
  if (!PROJECT_KEY.test(project))
    throw new CouldNotStart(
      `JIRA_SMOKE_PROJECT ${project} is not a Jira project key such as DEMO: capital letters, digits and underscores, starting with a letter`,
    );
  const ticketProject = ISSUE_KEY.exec(ticket)?.[1];
  if (ticketProject === undefined)
    throw new CouldNotStart(`JIRA_SMOKE_TICKET ${ticket} is not a Jira issue key such as DEMO-1`);
  if (ticketProject !== project)
    throw new CouldNotStart(
      `ticket ${ticket} is not in project ${project}, the only project the smoke test posts to`,
    );
  const api = get("JIRA_SMOKE_API");
  if (api !== undefined && !isRestBase(api))
    throw new CouldNotStart(
      `JIRA_SMOKE_API ${api} must be https://api.atlassian.com/ex/jira/<cloudId>; http only for 127.0.0.1 or localhost with a port`,
    );
  const inputs = {
    site,
    project,
    ticket,
    api,
    issueType: get("JIRA_SMOKE_ISSUE_TYPE") ?? "Bug",
    linkType: get("JIRA_SMOKE_LINK_TYPE") ?? "Relates",
  };
  return { inputs, credentials };
}

function isLoopback(url: URL): boolean {
  return url.protocol === "http:" && LOOPBACK_HOSTS.has(url.hostname) && url.port !== "";
}

function isRestBase(api: string): boolean {
  if (!URL.canParse(api)) return false;
  const url = new URL(api);
  return SCOPED_API.test(url.href) || isLoopback(url);
}

// browse links always use the site, as the CLI's client builds them
function siteUrl(site: string): URL {
  return new URL(`${isLoopback(new URL(`http://${site}`)) ? "http" : "https"}://${site}`);
}

function browseUrl(inputs: Inputs, key: string, commentId?: string): string {
  const url = new URL(`/browse/${key}`, siteUrl(inputs.site));
  if (commentId !== undefined) url.searchParams.set("focusedCommentId", commentId);
  return url.href;
}

/** The REST base the CLI's client uses: `api` when set, else the site. */
function restBase(inputs: Inputs): URL {
  return inputs.api === undefined ? siteUrl(inputs.site) : new URL(inputs.api);
}

type Send = (
  method: string,
  apiPath: string,
  options?: { query?: Record<string, string>; json?: unknown },
) => Promise<unknown>;

/** Jira REST with basic auth against the base the CLI's client uses, refusing any redirect. */
function jiraSender(inputs: Inputs, credentials: Credentials, signal: AbortSignal): Send {
  const base = restBase(inputs);
  const authorization = `Basic ${Buffer.from(`${credentials.email}:${credentials.token}`, "utf8").toString("base64")}`;
  return async (method, apiPath, options = {}) => {
    const url = new URL(base);
    url.pathname = `${base.pathname.replace(/\/$/, "")}${apiPath}`;
    url.search = new URLSearchParams(options.query ?? {}).toString();
    const headers: Record<string, string> = { authorization, accept: "application/json" };
    if (options.json !== undefined) headers["content-type"] = "application/json";
    let response: Response;
    try {
      response = await fetch(url, {
        method,
        headers,
        ...(options.json === undefined ? {} : { body: JSON.stringify(options.json) }),
        redirect: "error",
        signal: AbortSignal.any([signal, AbortSignal.timeout(REQUEST_TIMEOUT_MS)]),
      });
    } catch (error) {
      const cause = (error as Error).cause;
      const detail = cause instanceof Error ? ` (${cause.message})` : "";
      throw new Error(`${method} ${apiPath} failed: ${(error as Error).message}${detail}`, {
        cause: error,
      });
    }
    const body = parseJson(await response.text());
    if (!response.ok)
      throw new JiraAnswer(
        `${method} ${apiPath} answered ${response.status}${jiraErrors(body)}`,
        response.status,
      );
    return body;
  };
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
}

// Jira puts errors in errorMessages and in errors by field
function jiraErrors(body: unknown): string {
  const messages = at(body, "errorMessages");
  const fields = at(body, "errors");
  const all = [
    ...(Array.isArray(messages) ? messages : []),
    ...(typeof fields === "object" && fields !== null ? Object.values(fields) : []),
  ].filter((message) => typeof message === "string");
  return all.length === 0 ? "" : `: ${all.join("; ")}`;
}

function at(value: unknown, ...keys: (string | number)[]): unknown {
  let current = value;
  for (const key of keys) {
    if (typeof current !== "object" || current === null) return undefined;
    current = (current as Record<string | number, unknown>)[key];
  }
  return current;
}

/** The CLI's environment: the script's own, with the credentials only when given. */
function cliEnv(credentials: Credentials | undefined): NodeJS.ProcessEnv {
  const env = { ...process.env };
  for (const name of CREDENTIAL_NAMES) delete env[name];
  if (credentials === undefined) return env;
  return { ...env, JIRA_EMAIL: credentials.email, JIRA_API_TOKEN: credentials.token };
}

/** Runs the CLI from sources on the temporary project and passes its stderr on, masked. */
function cli(smoke: Smoke, ...args: string[]): Promise<CliRun> {
  // after Ctrl-C no later step starts
  smoke.signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      ["--conditions=development", cliMain, ...args, "--root", smoke.root],
      {
        cwd: smoke.root,
        env: smoke.env,
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8").on("data", (chunk: string) => (stdout += chunk));
    child.stderr.setEncoding("utf8").on("data", (chunk: string) => (stderr += chunk));
    child.on("error", reject);
    child.on("close", (code) => {
      if (stderr !== "") process.stderr.write(smoke.out.mask(stderr));
      resolve({ code, stdout, stderr });
    });
  });
}

/** One external regression case on a runner target, linked to the ticket, and a bug project with no transitions. */
async function writeProject(smoke: Smoke): Promise<void> {
  const { root, inputs, caseId } = smoke;
  const config = {
    envs: { [ENV]: { production: false, hosts: ["localhost"] } },
    // ingest never starts the command
    runners: {
      [TARGET]: { command: ["node", "--version"], results: "results/*.xml", format: "junit" },
    },
    targets: { [TARGET]: { runner: TARGET } },
    trackers: {
      jira: {
        site: inputs.site,
        ...(inputs.api === undefined ? {} : { api: inputs.api }),
        secrets: { email: "JIRA_EMAIL", token: "JIRA_API_TOKEN" },
        projects: {
          [inputs.project]: {
            bugs: { issueType: inputs.issueType, labels: [SMOKE_LABEL], linkType: inputs.linkType },
          },
        },
      },
    },
  };
  const spec = {
    id: caseId,
    title: "Direct Jira posting",
    stage: "regression",
    risk: "low",
    links: [`jira:${inputs.ticket}`],
    targets: [TARGET],
  };
  // JSON is YAML
  await writeFile(path.join(root, BRAND.configFile), `${JSON.stringify(config, null, 2)}\n`);
  await writeFile(path.join(root, ".gitignore"), `runs/\n${BRAND.stateDir}/\n`);
  await mkdir(path.join(root, "cases", "smoke"), { recursive: true });
  await writeFile(
    path.join(root, "cases", "smoke", "cases.yaml"),
    `${JSON.stringify({ cases: [spec] }, null, 2)}\n`,
  );
  await mkdir(path.join(root, "results"));
}

/** Writes one JUnit test tagged with the case id, failing or passing, and ingests it as run `runId`. */
async function ingest(smoke: Smoke, runId: string, failing: boolean): Promise<void> {
  const file = path.join(smoke.root, "results", `${runId}.xml`);
  const failure = failing ? '<failure message="fails on purpose for the smoke test"/>' : "";
  const testcase = `<testcase classname="Smoke" name="[${smoke.caseId}] posts to Jira">${failure}</testcase>`;
  await writeFile(file, `<testsuite name="smoke">\n  ${testcase}\n</testsuite>\n`);
  const run = await cli(smoke, "ingest", "--env", ENV, "--target", TARGET, "--run", runId, file);
  // ingest exits 1 when a case failed
  const expected = failing ? 1 : 0;
  if (run.code !== expected)
    throw new Error(
      `ingest of the ${failing ? "failing" : "passing"} result exited ${run.code}, not ${expected}`,
    );
}

async function reportPost(smoke: Smoke, runId: string): Promise<PostOutput> {
  const run = await cli(smoke, "report", "post", "--run", runId, "--json");
  const output = parseJson(run.stdout);
  const items = at(output, "items");
  const bugs = at(output, "bugs");
  if (!Array.isArray(items) || !Array.isArray(bugs))
    throw new Error(`report post --run ${runId} exited ${run.code} without its JSON output`);
  return { code: run.code, items: items as ItemOutcome[], bugs: bugs as BugOutcome[] };
}

function failures(output: PostOutput): string {
  const lines = [
    ...output.items
      .filter((item) => !item.ok)
      .map((item) => `failed ${item.ticket.key}: ${item.error ?? ""}`),
    ...output.bugs
      .filter((bug) => !bug.ok)
      .map((bug) => `failed ${bug.caseId}: ${bug.action}: ${bug.error ?? ""}`),
  ];
  return lines.length === 0 ? "" : `\n${lines.join("\n")}`;
}

/** Posts the failing result: a comment on the ticket and a new bug. */
async function failingRun(smoke: Smoke, send: Send): Promise<{ key: string; url: string }> {
  await ingest(smoke, FAIL_RUN, true);
  const output = await reportPost(smoke, FAIL_RUN);
  const item = output.items.find((outcome) => outcome.ticket.key === smoke.inputs.ticket);
  // a comment posted before a later sub-step failed still needs deleting
  if (item?.url !== undefined) {
    smoke.ticketComment = item.url;
    smoke.out.line(`ticket comment ${item.url}`);
  }
  const bug = output.bugs.find((outcome) => outcome.caseId === smoke.caseId);
  // a failed outcome still names a bug filed before its attach or link failed
  if (bug?.key !== undefined && ISSUE_KEY.test(bug.key) && bug.url !== undefined) {
    smoke.bug = { key: bug.key, url: bug.url };
    smoke.out.line(`bug ${bug.key} ${bug.url}`);
  } else if (bug !== undefined && !bug.ok && bug.action === `file a bug in ${smoke.inputs.project}`)
    await findFiledBug(smoke, send);
  if (
    output.code !== 0 ||
    item?.ok !== true ||
    bug?.ok !== true ||
    smoke.ticketComment === undefined ||
    smoke.bug === undefined
  )
    throw new Error(`report post of the failing result exited ${output.code}${failures(output)}`);
  return smoke.bug;
}

/** Names a bug the create may have filed before it failed, or before Ctrl-C; the label is unique to the run. */
async function findFiledBug(smoke: Smoke, send: Send): Promise<void> {
  const label = bugLabel(smoke.caseId);
  smoke.out.line(
    `the bug step failed after it may have filed a bug; searching ${smoke.inputs.project} for the label ${label}`,
  );
  let key: string | undefined;
  try {
    key = (await searchBug(smoke, send)).key;
  } catch {
    // the failure of the bug step explains the run better than a failed search
  }
  if (key === undefined) {
    smoke.possibleBugLabel = label;
    return;
  }
  smoke.bug = { key, url: browseUrl(smoke.inputs, key) };
  smoke.out.line(`bug ${key} ${smoke.bug.url}`);
  smoke.out.line(`${key} was filed before the step that failed`);
}

// mirrors bugLabel in packages/core/src/report/bugs.ts
function bugLabel(caseId: string): string {
  return `${BRAND.markerPrefix}-${caseId}`;
}

/**
 * Sends the search `findOpenBug` sends for the run's bug label every `SEARCH_PAUSE_MS`, for at most
 * `SEARCH_LIMIT_MS`, since Jira's search lags behind a create. Stops at the first key, or at `until` when given.
 * A try that may pass later is retried; any other failure throws.
 */
async function searchBug(smoke: Smoke, send: Send, until?: string): Promise<Search> {
  const jql = `project = "${jqlString(smoke.inputs.project)}" AND labels = "${jqlString(bugLabel(smoke.caseId))}" AND statusCategory != Done ORDER BY created DESC`;
  const started = performance.now();
  let failed: Error | undefined;
  for (;;) {
    let body: unknown;
    try {
      body = await send("POST", "/rest/api/3/search/jql", {
        json: { jql, fields: ["created"], maxResults: 1 },
      });
      failed = undefined;
    } catch (error) {
      if (!mayPass(error)) throw error;
      failed = error as Error;
    }
    const elapsed = performance.now() - started;
    const key = at(body, "issues", 0, "key");
    if (typeof key === "string" && (until === undefined ? ISSUE_KEY.test(key) : key === until))
      return { key, elapsed, failed: undefined };
    if (elapsed + SEARCH_PAUSE_MS > SEARCH_LIMIT_MS) return { key: undefined, elapsed, failed };
    await sleep(SEARCH_PAUSE_MS, undefined, { signal: smoke.signal });
  }
}

/** Waits until the search finds the new bug, since the passing run finds it through the same search. */
async function waitForSearch(smoke: Smoke, send: Send, key: string): Promise<void> {
  const skipped = "skipped the passing run and the probe";
  let search: Search;
  try {
    search = await searchBug(smoke, send, key);
  } catch (error) {
    throw new Error(`${(error as Error).message}; ${skipped}`, { cause: error });
  }
  if (search.key === undefined)
    throw new Error(
      `the search did not find ${key} within ${SEARCH_LIMIT_MS / 1000} s${search.failed === undefined ? "" : ` (the last try: ${search.failed.message})`}, so the passing run would not find the bug; ${skipped}`,
    );
  smoke.out.line(`the search found ${key} after ${(search.elapsed / 1000).toFixed(1)} s`);
}

function jqlString(value: string): string {
  return value.replaceAll("\\", "\\\\").replaceAll('"', '\\"');
}

/** Posts the passing result, which comments on the open bug. */
async function passingRun(smoke: Smoke, key: string): Promise<void> {
  await ingest(smoke, PASS_RUN, false);
  const output = await reportPost(smoke, PASS_RUN);
  const bug = output.bugs.find((outcome) => outcome.caseId === smoke.caseId);
  if (output.code !== 0 || bug?.ok !== true || bug.key !== key || bug.url === undefined) {
    // a failed outcome names its step in failures()
    const why = bug?.ok === false ? "" : `: ${bug?.action ?? "no bug outcome"}`;
    throw new Error(
      `report post of the passing result did not comment on ${key}${why}${failures(output)}`,
    );
  }
  smoke.out.line(`recovery comment ${bug.url}`);
}

async function probe(smoke: Smoke, send: Send, key: string): Promise<void> {
  const apiPath = `/rest/api/3/issue/${key}/comment`;
  const id = at(await send("POST", apiPath, { json: { body: PROBE } }), "id");
  if (typeof id !== "string" || !COMMENT_ID.test(id))
    throw new Error(`POST ${apiPath} answered without a comment id`);
  smoke.out.line(`probe comment ${browseUrl(smoke.inputs, key, id)}`);
}

async function realRun(smoke: Smoke, credentials: Credentials): Promise<void> {
  const { out, inputs } = smoke;
  const send = jiraSender(inputs, credentials, smoke.signal);
  let status: unknown;
  try {
    status = at(
      await send("GET", `/rest/api/3/issue/${inputs.ticket}`, { query: { fields: "status" } }),
      "fields",
      "status",
      "name",
    );
  } catch (error) {
    const reason = (error as Error).message.replace(/\.$/, "");
    throw new CouldNotStart(
      `cannot read ${inputs.ticket} at ${restBase(inputs).href}, so nothing was posted: ${reason}; check JIRA_EMAIL, JIRA_API_TOKEN and JIRA_SMOKE_SITE, set JIRA_SMOKE_API for a scoped token, and check that ${inputs.ticket} exists`,
    );
  }
  out.line(`read ${inputs.ticket}: ${typeof status === "string" ? status : "no status name"}`);
  await writeProject(smoke);
  const bug = await failingRun(smoke, send);
  await waitForSearch(smoke, send, bug.key);
  await passingRun(smoke, bug.key);
  await probe(smoke, send, bug.key);
  out.line("");
  out.line("Check on the site:");
  out.line(
    `1. ${bug.key} is in project ${inputs.project} with issue type ${inputs.issueType}, so creating it through project.key and issuetype.name worked.`,
  );
  out.line(
    `2. ${bug.key} has the labels ${SMOKE_LABEL} and ${bugLabel(smoke.caseId)}, and a link of type ${inputs.linkType} to ${inputs.ticket}.`,
  );
  out.line("3. Each focusedCommentId link above opens its comment.");
  out.line(`4. The probe comment on ${bug.key} shows a folded section titled "${PROBE_TITLE}".`);
}

async function dryRun(smoke: Smoke): Promise<void> {
  const { out, inputs, caseId } = smoke;
  out.line(
    `dry run for ${inputs.site}, project ${inputs.project}, ticket ${inputs.ticket}: no credentials read, nothing sent`,
  );
  out.line(`1. read ${inputs.ticket}, and stop before posting when that fails`);
  out.line(`2. ingest a failing result for ${caseId}, then report post:`);
  await writeProject(smoke);
  await ingest(smoke, FAIL_RUN, true);
  const run = await cli(smoke, "report", "post", "--run", FAIL_RUN, "--dry-run");
  if (run.code !== 0) throw new Error(`report post --dry-run exited ${run.code}`);
  for (const line of run.stdout.trimEnd().split("\n")) out.line(`   ${line}`);
  out.line(
    `3. search ${inputs.project} for the label ${bugLabel(caseId)} until the new bug comes back, for at most ${SEARCH_LIMIT_MS / 1000} s`,
  );
  out.line(
    "4. ingest a passing result, then report post, which comments on the bug and moves nothing",
  );
  out.line("5. post a probe comment with an expand node on the bug");
}

/** Everything the run created, for the person to delete. */
function cleanupLine(smoke: Smoke): string | undefined {
  const created = [
    ...(smoke.bug === undefined
      ? []
      : [`the bug ${smoke.bug.key}, which takes its comments with it`]),
    ...(smoke.possibleBugLabel === undefined
      ? []
      : [
          `any bug in ${smoke.inputs.project} labelled ${smoke.possibleBugLabel}, which the run may have filed`,
        ]),
    ...(smoke.ticketComment === undefined ? [] : [`the comment on ${smoke.inputs.ticket}`]),
  ];
  return created.length === 0 ? undefined : `Delete afterwards: ${created.join(", and ")}.`;
}

/**
 * Reads `JIRA_SMOKE_SITE`, `JIRA_SMOKE_PROJECT`, `JIRA_SMOKE_TICKET`, `JIRA_EMAIL` and `JIRA_API_TOKEN`, and
 * optionally `JIRA_SMOKE_API`, `JIRA_SMOKE_ISSUE_TYPE` and `JIRA_SMOKE_LINK_TYPE`, from the environment or the
 * `--inputs` file outside the repository (`scripts/.jira-smoke.env` by default). Exits 0 when every step worked,
 * 1 when one failed and 2 when it stopped before posting.
 */
async function main(argv: readonly string[]): Promise<number> {
  let flags: { "dry-run"?: boolean; keep?: boolean; inputs?: string };
  try {
    flags = parseArgs({
      args: [...argv],
      options: {
        "dry-run": { type: "boolean" },
        keep: { type: "boolean" },
        inputs: { type: "string" },
      },
      strict: true,
      allowPositionals: false,
    }).values;
  } catch (error) {
    console.error((error as Error).message);
    console.error(USAGE);
    return 2;
  }
  const out = new Output();
  let smoke: Smoke | undefined;
  const interrupt = new AbortController();
  const abort = () => interrupt.abort();
  // the first Ctrl-C ends the run through the catch and finally below; a second one stops the process as usual
  process.once("SIGINT", abort);
  try {
    const dry = flags["dry-run"] === true;
    const { inputs, credentials } = await loadInputs(await inputsFile(flags.inputs), dry);
    if (credentials !== undefined) {
      const basic = Buffer.from(`${credentials.email}:${credentials.token}`, "utf8").toString(
        "base64",
      );
      out.hide(credentials.token, credentials.email, basic);
    }
    const stamp = new Date().toISOString().replace(/\D/g, "");
    smoke = {
      out,
      inputs,
      root: await mkdtemp(path.join(tmpdir(), "jira-smoke-")),
      // UTC yymmdd and HHMMSS split by a hyphen, since the redactor masks any run of eight or more digits
      caseId: `SMOKE-JIRA${stamp.slice(2, 8)}-${stamp.slice(8, 14)}`,
      env: cliEnv(credentials),
      signal: interrupt.signal,
    };
    if (credentials === undefined) await dryRun(smoke);
    else await realRun(smoke, credentials);
    const cleanup = cleanupLine(smoke);
    if (cleanup !== undefined) out.line(cleanup);
    return 0;
  } catch (error) {
    out.error(error instanceof Error ? error.message : String(error));
    const cleanup = smoke === undefined ? undefined : cleanupLine(smoke);
    if (cleanup !== undefined) out.line(cleanup);
    return error instanceof CouldNotStart ? 2 : 1;
  } finally {
    process.off("SIGINT", abort);
    if (smoke !== undefined) {
      if (flags.keep === true) out.line(`kept the temporary project ${smoke.root}`);
      else await rm(smoke.root, { recursive: true, force: true });
    }
  }
}

if (import.meta.main) process.exitCode = await main(process.argv.slice(2));
