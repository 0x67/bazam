import { randomUUID } from "node:crypto";
import { copyFile, lstat, mkdir, mkdtemp, readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, posix, relative, resolve, sep } from "node:path";
import { BRAND } from "@bazam/core/brand";
import {
  CASE_ID,
  promoteCase,
  RoleRefused,
  roleBindings,
  selectCases,
  Stage,
  type CaseFilter,
  type LoadIssue,
} from "@bazam/core/case";
import { checkProject } from "@bazam/core/check";
import { RunValues } from "@bazam/core/env";
import { PluginRegistry, type PluginManifest } from "@bazam/core/plugin";
import { FIXTURES_FILE, loadProject, loadProjectConfig, type Project, type ProjectConfig } from "@bazam/core/project";
import type { Redactor } from "@bazam/core/redact";
import {
  buildPostPlans,
  loadReceipts,
  MediaRefs,
  PeopleRegistry,
  recordReceipt,
  type PostPlan,
  type PostPlanItem,
} from "@bazam/core/report";
import { newRunId, type CaseResult } from "@bazam/core/result";
import { planCases } from "@bazam/core/run";
import driverWeb from "@bazam/driver-web";
import resolvers from "@bazam/resolvers";
import jira from "@bazam/tracker-jira";
import { z } from "zod";
import { PLAIN_NAME, type RunSupervisor } from "./runs.ts";

/** Registered after core and before the plugins the config lists, as the CLI does. */
const DEFAULT_PLUGINS: readonly PluginManifest[] = [driverWeb, resolvers, jira];
const ANSWERS_CHANNEL = "answers-file";
// seven digits at most, so the redactor's rule for runs of eight or more leaves the seed readable
const RANDOM_SEED_LIMIT = 10_000_000;
// cases/<domain>/<name>.yaml, the only depth at which the loader reads case files
const DRAFT_PATH = /^cases\/([A-Za-z0-9][A-Za-z0-9._-]*)\/[A-Za-z0-9][A-Za-z0-9._-]*\.yaml$/;

export interface ToolDeps {
  /** Absolute. */
  projectRoot: string;
  supervisor: RunSupervisor;
  redactor: Redactor;
  /** The registries this call loaded, which the server closes when the call ends. */
  registries: PluginRegistry[];
}

/** What a tool hands back; the server masks it before it leaves. */
export interface ToolReply {
  /** Sent as JSON text. */
  doc: unknown;
  /** `registered` masks only the registered values, for a doc the tool already masked field by field. */
  masking?: "all" | "registered";
  /** PNG bytes as base64, sent as image content and left unmasked: screenshots are masked when taken. */
  images?: { name: string; data: string; mimeType: string }[];
}

export interface ToolDefinition<Input extends z.ZodObject = z.ZodObject> {
  name: string;
  description: string;
  input: Input;
  handle(input: z.output<Input>, deps: ToolDeps): Promise<ToolReply>;
}

/** A tool refused its input or the project; the server sends the message and the issues as the tool error. */
export class ToolError extends Error {
  readonly issues: readonly LoadIssue[];

  constructor(message: string, issues: readonly LoadIssue[] = []) {
    super(message);
    this.name = "ToolError";
    this.issues = issues;
  }
}

function defineTool<Input extends z.ZodObject>(tool: ToolDefinition<Input>): ToolDefinition {
  return tool;
}

const Names = z.array(z.string().min(1)).min(1).exactOptional();

const Filter = z
  .object({
    ids: Names,
    domains: Names,
    stages: z.array(Stage).min(1).exactOptional(),
    targets: Names,
    links: Names.describe("Ticket links such as jira:DEMO-1."),
    tags: Names,
  })
  .describe(
    "Each field narrows the selection, and a case matches a field when any of its values matches. Without stages, run_plan and run_start leave retired cases out, and cases_search keeps every stage.",
  );

// zod drops a __proto__ key from a record, so it would pass as no role at all
const Roles = z
  .preprocess(
    (value, ctx) => {
      if (typeof value === "object" && value !== null && Object.hasOwn(value, "__proto__")) {
        ctx.issues.push({ code: "custom", message: 'unknown role "__proto__"', input: value });
      }
      return value;
    },
    z.record(z.string().min(1), z.string().min(1)),
  )
  .exactOptional()
  .describe(
    "The identity each role plays in this run, by role, such as { tester: alice }; a role left out plays its default.",
  );

const Env = z.string().min(1).describe(`An env from ${BRAND.configFile}.`);
const RunId = z
  .string()
  .regex(PLAIN_NAME)
  .describe("A run id: the one run_start returned, or the name of a folder under runs/.");

const Answer = z
  .discriminatedUnion("kind", [
    z.object({
      kind: z.literal("verdict"),
      verdict: z.enum(["pass", "fail", "blocked"]),
      note: z.string().default(""),
    }),
    z.object({ kind: z.literal("value"), value: z.string().min(1) }),
    z.object({ kind: z.literal("done") }),
  ])
  .describe(
    "A verdict prompt takes a verdict; an action prompt takes done or a verdict; a value prompt takes the value, or a fail or blocked verdict.",
  );

export const caseTools: readonly ToolDefinition[] = [
  defineTool({
    name: "cases_search",
    description:
      "Finds existing cases in every stage, retired ones included, unless the filter names stages. Search before case_draft, and extend the case that already covers a ticket's behavior instead of adding another.",
    input: z.object({
      text: z
        .string()
        .default("")
        .describe(
          "Words that must all appear somewhere in the case, such as its id, title, domain, links, tags, steps or checks; letter case does not matter.",
        ),
      filter: Filter.default({}),
    }),
    async handle({ text, filter }, deps) {
      const { project } = await loadWorkspace(deps);
      const words = text.toLowerCase().split(/\s+/).filter(Boolean);
      // without stages, selectCases keeps only the stages that run, and a search covers retired cases too
      const cases = selectCases(project.cases, { stages: [...Stage.options], ...filter })
        .filter(({ spec, domain }) => {
          const haystack = `${domain}\n${JSON.stringify(spec)}`.toLowerCase();
          return words.every((word) => haystack.includes(word));
        })
        .map(({ spec, source }) => ({
          id: spec.id,
          title: spec.title,
          stage: spec.stage,
          links: spec.links,
          file: source.file,
        }));
      return { doc: { cases } };
    },
  }),
  defineTool({
    name: "case_draft",
    description:
      "Checks a case file as the project would load it and writes it only when it adds no error. Returns the issues either way.",
    input: z.object({
      file: z.string().min(1).describe("cases/<domain>/<name>.yaml, relative to the project root."),
      yaml: z.string().describe("The whole file: a mapping with a cases list."),
    }),
    async handle({ file, yaml }, deps) {
      return { doc: await draftCase(deps, file, yaml) };
    },
  }),
  defineTool({
    name: "case_check",
    description: `Runs every check rule over the project, as ${BRAND.name} check does.`,
    input: z.object({
      files: z
        .array(z.string().min(1))
        .min(1)
        .exactOptional()
        .describe("Report only the issues in these files, relative to the root with forward slashes."),
    }),
    async handle({ files }, deps) {
      const issues = await checkIssues(deps);
      return { doc: issueReport(files === undefined ? issues : issues.filter((issue) => files.includes(issue.file))) };
    },
  }),
  defineTool({
    name: "case_promote",
    description:
      "Moves an acceptance case to regression when its latest result in the env passed and it is not a once case. Otherwise the reply has ok: false and the reason.",
    input: z.object({ id: z.string().regex(CASE_ID), env: Env }),
    async handle({ id, env }, deps) {
      const { project } = await loadWorkspace(deps);
      const target = project.cases.find((loaded) => loaded.spec.id === id);
      if (target === undefined) throw new ToolError(`no case ${id} loaded; case_check reports cases that do not load`);
      if (project.config.envs[env] === undefined) throw new ToolError(unknownEnv(project, env));
      return { doc: { caseId: id, ...(await promoteCase(project.root, target, env)) } };
    },
  }),
  defineTool({
    name: "run_plan",
    description: "Shows what a run would do, with no step run and no login made.",
    input: z.object({ filter: Filter.default({}), env: Env, roles: Roles }),
    async handle({ filter, env, roles }, deps) {
      const { project, registry, environment, cases } = await selectRun(deps, filter, env, roles);
      const startedAt = new Date();
      const runId = newRunId(startedAt, Math.random);
      const runDir = join(project.root, "runs", runId);
      const seed = Math.floor(Math.random() * RANDOM_SEED_LIMIT);
      const plan = await planCases({
        project,
        env: environment,
        cases,
        registry,
        channel: registry.channel(ANSWERS_CHANNEL)(runDir),
        runDir,
        runValues: new RunValues(runId, startedAt, seed),
        seed,
        redactor: deps.redactor,
        signal: new AbortController().signal,
        ...(filter.targets === undefined ? {} : { targets: filter.targets }),
        ...(roles === undefined ? {} : { roles }),
      });
      return { doc: plan };
    },
  }),
  defineTool({
    name: "run_start",
    description:
      "Starts the run in the background and returns its id at once. Follow it with run_status and answer person prompts with prompt_list and prompt_answer.",
    input: z.object({
      filter: Filter.default({}),
      env: Env,
      roles: Roles,
      seed: z
        .number()
        .int()
        .min(0)
        .max(Number.MAX_SAFE_INTEGER)
        .exactOptional()
        .describe(
          "The seed of an earlier run, to replay its generated values: the seed field of any case's result.json from that run, which evidence_get returns.",
        ),
    }),
    async handle({ filter, env, roles, seed }, deps) {
      // refuse here what the run would refuse, so the error reaches the agent instead of a log file
      await selectRun(deps, filter, env, roles);
      return { doc: await deps.supervisor.start(filter, env, seed, roles) };
    },
  }),
  defineTool({
    name: "run_status",
    description: "The run's state, its results so far and the number of prompts waiting for a person.",
    input: z.object({ runId: RunId }),
    async handle({ runId }, deps) {
      return { doc: await deps.supervisor.status(runId) };
    },
  }),
  defineTool({
    name: "evidence_get",
    description:
      "A case's result.json from a run and its attachment paths; with includeImages, its screenshots as images.",
    input: z.object({
      runId: RunId,
      caseId: z.string().regex(CASE_ID),
      includeImages: z.boolean().default(false),
    }),
    async handle({ runId, caseId, includeImages }, deps) {
      const caseDir = join(deps.projectRoot, "runs", runId, caseId);
      const text = await readFile(join(caseDir, "result.json"), "utf8").catch((error: unknown) => {
        if (isMissing(error)) throw new ToolError(`run ${runId} has no result for ${caseId}`);
        throw error;
      });
      const result = JSON.parse(text) as CaseResult;
      // names come from the result only, and only plain ones, so none points outside the case folder
      const names = result.attachments.filter((name) => PLAIN_NAME.test(name));
      const path = (name: string) => posix.join("runs", runId, caseId, name);
      const images = [];
      for (const name of includeImages ? names.filter((n) => n.endsWith(".png")) : []) {
        const data = (await readFile(join(caseDir, name))).toString("base64");
        images.push({ name: path(name), data, mimeType: "image/png" });
      }
      return { doc: { result, attachments: names.map(path) }, images };
    },
  }),
  defineTool({
    name: "prompt_list",
    description: "The prompts in a run that wait for a person; relay each one and answer it with prompt_answer.",
    input: z.object({ runId: RunId }),
    async handle({ runId }, deps) {
      return { doc: { prompts: await deps.supervisor.prompts(runId) } };
    },
  }),
  defineTool({
    name: "prompt_answer",
    description: "Answers a pending prompt with what the person said.",
    input: z.object({
      runId: RunId,
      promptId: z.string().regex(PLAIN_NAME).describe("The id prompt_list gave."),
      answer: Answer,
    }),
    async handle({ runId, promptId, answer }, deps) {
      // later responses mask the value, as the run masks it in its evidence
      if (answer.kind === "value") deps.redactor.register(answer.value);
      await deps.supervisor.answer(runId, promptId, answer);
      return { doc: { ok: true } };
    },
  }),
  defineTool({
    name: "report_plan",
    description:
      "The run's post plan: one tracker comment per linked ticket for every acceptance result and for each regression result that failed or was blocked. Post each comment with a tracker connector, or edit the comment at edit.url when the item has one, then acknowledge it with report_ack.",
    input: z.object({
      runId: RunId,
      media: MediaRefs.exactOptional().describe(
        "Screenshots already uploaded to the tracker, keyed by the path in an item's attachments (<case-id>/<file>, relative to the run directory), so the comment's html shows them inline.",
      ),
    }),
    async handle({ runId, media }, deps) {
      const { project, registry } = await loadWorkspace(deps);
      const results = await readResults(join(project.root, "runs", runId), runId);
      const [first] = results;
      if (first === undefined) throw new ToolError(`run ${runId} has no case results`);
      const plan = buildPostPlans({
        runId,
        env: first.env,
        results,
        specs: new Map(project.cases.map(({ spec }) => [spec.id, spec])),
        people: await PeopleRegistry.load(project.root),
        receipts: await loadReceipts(join(project.root, BRAND.stateDir)),
        trackers: (name) => registry.tracker(name),
        transitions: project.config.trackers,
        ...(media === undefined ? {} : { media }),
        now: new Date(),
      });
      // only the comments are masked whole, as the runner does: the digit rule would break account ids and receipt URLs;
      // the agent posts the html or the markdown, so the adf body stays out of the reply
      const items = plan.items.map(({ comment: { adf: _adf, ...comment }, ...item }) => ({
        ...item,
        comment: deps.redactor.value(comment),
      }));
      return { doc: { ...plan, items }, masking: "registered" };
    },
  }),
  defineTool({
    name: "report_ack",
    description:
      "Records the URL of a posted comment. When the case sets report.comment to update, the next post plan for that case and ticket edits this comment instead of posting a new one.",
    input: z.object({
      marker: z.string().min(1).describe(`The item's marker, ${BRAND.markerPrefix}:<case-id>:<run-id>.`),
      ticket: z
        .string()
        .min(1)
        .exactOptional()
        .describe("<tracker>:<key>, needed when several items share the marker."),
      url: z.string().min(1).describe("The URL of the posted comment."),
    }),
    async handle({ marker, ticket, url }, deps) {
      if (!URL.canParse(url)) throw new ToolError(`"${url}" is not a URL`);
      const plan = await readPostPlan(join(deps.projectRoot, "runs", runIdOf(marker)));
      const item = itemFor(plan, marker, ticket);
      await recordReceipt(join(deps.projectRoot, BRAND.stateDir), item, url, new Date());
      return { doc: { marker, ticket: `${item.ticket.tracker}:${item.ticket.key}`, caseId: item.caseId } };
    },
  }),
];

/** Loads the registry from the real root, where path plugins resolve, and adds it to the call's registries. */
async function loadPlugins(deps: ToolDeps): Promise<{ config: ProjectConfig; registry: PluginRegistry }> {
  const root = deps.projectRoot;
  const { config, issues } = await loadProjectConfig(root);
  if (config === undefined) throw new ToolError(`the project config in ${root} does not load`, issues);
  const registry = await PluginRegistry.load(config, root, DEFAULT_PLUGINS, {
    // stdout carries the protocol, so plugin output goes to stderr
    log: (line) => process.stderr.write(`${deps.redactor.text(line)}\n`),
    redactor: deps.redactor,
  });
  deps.registries.push(registry);
  return { config, registry };
}

async function loadWorkspace(deps: ToolDeps): Promise<{ project: Project; registry: PluginRegistry }> {
  const { registry } = await loadPlugins(deps);
  return { project: await loadProject(deps.projectRoot, registry), registry };
}

/** Refuses, as a run does, a project with load issues, an unknown env and a selection with no case. */
async function selectRun(
  deps: ToolDeps,
  filter: CaseFilter,
  env: string,
  roles: Readonly<Record<string, string>> = {},
) {
  const { project, registry } = await loadWorkspace(deps);
  const loadErrors = project.issues.filter(isError);
  if (loadErrors.length > 0) throw new ToolError("the project has load issues; fix them and start again", loadErrors);
  const environment = project.config.envs[env];
  if (environment === undefined) throw new ToolError(unknownEnv(project, env));
  const cases = selectCases(project.cases, filter);
  if (cases.length === 0) throw new ToolError("no case matches the selection");
  try {
    roleBindings(project.config.roles, roles);
  } catch (error) {
    if (error instanceof RoleRefused) throw new ToolError(error.message);
    throw error;
  }
  return { project, registry, environment, cases };
}

function unknownEnv(project: Project, env: string): string {
  const envs = Object.keys(project.config.envs);
  return `unknown env "${env}"; envs: ${envs.length === 0 ? "none" : envs.join(", ")}`;
}

/** Config issues are findings here, not a reason the check cannot run. */
async function checkIssues(deps: ToolDeps): Promise<LoadIssue[]> {
  const { config, issues } = await loadProjectConfig(deps.projectRoot);
  if (config === undefined) return issues;
  const { project, registry } = await loadWorkspace(deps);
  return checkProject(project, registry.checkRules());
}

function issueReport(issues: readonly LoadIssue[]) {
  const sorted = [...issues].sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line);
  const errors = sorted.filter(isError).length;
  return { issues: sorted, errors, warnings: sorted.length - errors };
}

/**
 * Loads and checks a copy of the project with the draft in place, since the loader reads only from disk. An error
 * blocks the write when it is in the draft, or when the same copy without the draft does not have it. Errors the
 * project already had block nothing, and neither does the state-ignored rule, which in a copy outside the repository
 * cannot ask git and reads only the copy's root .gitignore.
 */
async function draftCase(deps: ToolDeps, file: string, yaml: string) {
  const root = deps.projectRoot;
  const match = DRAFT_PATH.exec(file);
  if (match === null) throw new ToolError(`"${file}" is not a case file; name it cases/<domain>/<name>.yaml`);
  // the loader skips linked domain folders, and a write through a link could land outside cases/
  await refuseLink(root, "cases");
  await refuseLink(root, `cases/${match[1]}`);
  const { config, registry } = await loadPlugins(deps);
  const copy = await mkdtemp(join(tmpdir(), `${BRAND.name}-draft-`));
  let before: LoadIssue[];
  let after: LoadIssue[];
  try {
    await copyProjectFiles(root, copy, config);
    before = checkProject(await loadProject(copy, registry), registry.checkRules());
    await mkdir(dirname(join(copy, file)), { recursive: true });
    await writeFile(join(copy, file), yaml);
    after = checkProject(await loadProject(copy, registry), registry.checkRules());
  } finally {
    await rm(copy, { recursive: true, force: true });
  }
  const known = new Set(before.filter(isError).map(issueKey));
  // a duplicate id is reported on whichever file comes later, which may be another file than the draft
  const issues = after.filter((issue) => issue.file === file || (isError(issue) && !known.has(issueKey(issue))));
  const written = !issues.some(isError);
  // the case text is written as given: the check rules guard it, and masking would rewrite valid YAML
  if (written) await writeAtomically(join(root, file), yaml);
  return { file, written, ...issueReport(issues) };
}

async function refuseLink(root: string, folder: string): Promise<void> {
  const stats = await lstat(join(root, folder)).catch((error: unknown) => {
    if (isMissing(error)) return undefined;
    throw error;
  });
  if (stats !== undefined && !stats.isDirectory()) {
    throw new ToolError(`${folder} is a link or a file; case_draft writes only into plain folders under cases/`);
  }
}

/** The files loadProject reads, copied to `to` at the same paths. */
async function copyProjectFiles(root: string, to: string, config: ProjectConfig): Promise<void> {
  const paths = [
    BRAND.configFile,
    ".gitignore",
    "suites.yaml",
    FIXTURES_FILE,
    "cases/.retired",
    ...(await yamlFiles(root, "flows")),
    ...(await caseFiles(root)),
    ...mappingFiles(root, config),
  ];
  for (const path of paths) {
    await mkdir(dirname(join(to, path)), { recursive: true });
    await copyFile(join(root, path), join(to, path)).catch((error: unknown) => {
      if (!isMissing(error)) throw error;
    });
  }
}

// each runner's mapping file, when it lies inside the root; the copy holds nothing from outside it
function mappingFiles(root: string, config: ProjectConfig): string[] {
  return Object.values(config.runners).flatMap(({ mapping }) => {
    if (mapping === undefined) return [];
    const path = relative(root, resolve(root, mapping));
    return path === "" || path === ".." || path.startsWith(`..${sep}`) || isAbsolute(path) ? [] : [path];
  });
}

// cases/<domain>/*.yaml, skipping domain folders whose names start with a dot, as the loader does
async function caseFiles(root: string): Promise<string[]> {
  const domains = (await entries(join(root, "cases"))).filter((e) => e.isDirectory() && !e.name.startsWith("."));
  const files: string[] = [];
  for (const domain of domains) files.push(...(await yamlFiles(root, posix.join("cases", domain.name))));
  return files;
}

async function yamlFiles(root: string, folder: string): Promise<string[]> {
  return (await entries(join(root, folder)))
    .filter((entry) => entry.isFile() && entry.name.endsWith(".yaml"))
    .map((entry) => posix.join(folder, entry.name));
}

async function entries(folder: string) {
  try {
    return await readdir(folder, { withFileTypes: true });
  } catch (error) {
    if (isMissing(error)) return [];
    throw error;
  }
}

async function writeAtomically(file: string, text: string): Promise<void> {
  await mkdir(dirname(file), { recursive: true });
  const temp = `${file}.${randomUUID()}.tmp`;
  await writeFile(temp, text);
  await rename(temp, file);
}

/** The run's case results in the order they started; the preflight, prompts and answers folders hold no case. */
async function readResults(runDir: string, runId: string): Promise<CaseResult[]> {
  let found;
  try {
    found = await readdir(runDir, { withFileTypes: true });
  } catch (error) {
    if (isMissing(error)) throw new ToolError(`no run ${runId} has started`);
    throw error;
  }
  const results: CaseResult[] = [];
  for (const entry of found.filter((e) => e.isDirectory() && CASE_ID.test(e.name))) {
    const text = await readFile(join(runDir, entry.name, "result.json"), "utf8").catch((error: unknown) => {
      if (isMissing(error)) return undefined;
      throw error;
    });
    if (text !== undefined) results.push(JSON.parse(text) as CaseResult);
  }
  return results.sort((a, b) => a.startedAt.localeCompare(b.startedAt) || a.caseId.localeCompare(b.caseId));
}

async function readPostPlan(runDir: string): Promise<PostPlan> {
  const file = join(runDir, "post-plan.json");
  let plan: Partial<PostPlan>;
  try {
    plan = JSON.parse(await readFile(file, "utf8")) as Partial<PostPlan>;
  } catch (error) {
    throw new ToolError(
      `cannot read ${file}: ${(error as Error).message}; the run writes it when it finishes, so call report_ack again once run_status shows the run finished`,
    );
  }
  if (!Array.isArray(plan.items)) throw new ToolError(`${file} has no items`);
  return plan as PostPlan;
}

// `<prefix>:<case-id>:<run-id>`, as buildPostPlans writes it
function runIdOf(marker: string): string {
  const [prefix, caseId, runId, ...rest] = marker.split(":");
  if (
    prefix !== BRAND.markerPrefix ||
    caseId === undefined ||
    !CASE_ID.test(caseId) ||
    runId === undefined ||
    !PLAIN_NAME.test(runId) ||
    rest.length > 0
  ) {
    throw new ToolError(`"${marker}" is not a marker; one looks like ${BRAND.markerPrefix}:<case-id>:<run-id>`);
  }
  return runId;
}

/** A case with several links posts one item per ticket under one marker, so the ticket picks among them. */
function itemFor(plan: PostPlan, marker: string, ticket: string | undefined): PostPlanItem {
  const items = plan.items.filter(
    (item) =>
      item.marker === marker && (ticket === undefined || `${item.ticket.tracker}:${item.ticket.key}` === ticket),
  );
  const [item, ...others] = items;
  if (item === undefined) {
    throw new ToolError(`run ${plan.runId} has no item ${marker}${ticket === undefined ? "" : ` for ${ticket}`}`);
  }
  if (others.length > 0) {
    const tickets = items.map((i) => `${i.ticket.tracker}:${i.ticket.key}`).join(", ");
    throw new ToolError(`several items share ${marker}; pass ticket with one of ${tickets}`);
  }
  return item;
}

function issueKey(issue: LoadIssue): string {
  return JSON.stringify([issue.ruleId, issue.file, issue.message]);
}

function isError(issue: LoadIssue): boolean {
  return issue.severity === "error";
}

function isMissing(error: unknown): boolean {
  return (error as NodeJS.ErrnoException).code === "ENOENT";
}
