import { readdir, readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { BRAND } from "@bazam/core/brand";
import { CASE_ID } from "@bazam/core/case";
import type { PluginRegistry } from "@bazam/core/plugin";
import type { Project, ProjectConfig, TrackerConfig } from "@bazam/core/project";
import {
  applyBugs,
  buildPostPlans,
  describeDirectPost,
  loadReceipts,
  MediaRefs,
  PeopleRegistry,
  planBugs,
  postPlanDirect,
  recordReceipt,
  type BugIntent,
  type BugOutcome,
  type ItemOutcome,
  type PostPlan,
  type PostPlanItem,
} from "@bazam/core/report";
import type { CaseResult } from "@bazam/core/result";
import { resolveSecret } from "@bazam/core/secrets";
import { CommandError, ExitCode } from "../exit.ts";
import type { CommandContext } from "../main.ts";
import { runDirOf } from "./plan.ts";

/** `report plan`, `report post` and `report ack`. */
export async function reportCommand(ctx: CommandContext): Promise<ExitCode> {
  const [action] = ctx.args;
  if (action === "plan") return reportPlan(ctx);
  if (action === "post") return reportPost(ctx);
  if (action === "ack") return reportAck(ctx);
  throw new CommandError(
    action === undefined
      ? "report needs an action: plan, post or ack"
      : `report takes plan, post or ack, not "${action}"`,
  );
}

/** The run's post plan, built again with its comments masked, and what it was built from. */
interface RebuiltPlan {
  project: Project;
  registry: PluginRegistry;
  runId: string;
  runDir: string;
  results: CaseResult[];
  media: MediaRefs | undefined;
  plan: PostPlan;
}

/**
 * Builds the run's post plan again from its results and the receipts recorded since, so an item for a case with
 * `report.comment: update` carries the comment to edit. Leaves post-plan.json as the run wrote it.
 */
async function rebuildPlan(ctx: CommandContext): Promise<RebuiltPlan> {
  const { flags } = ctx;
  if (flags.run === undefined) throw new CommandError("--run is required: name the run to report");
  const { project, registry } = await ctx.load();
  const runDir = runDirOf(project.root, flags.run);
  const results = await readResults(runDir);
  const [first] = results;
  if (first === undefined) throw new CommandError(`run ${flags.run} has no case results`);
  const media = flags.media === undefined ? undefined : await readMedia(resolve(ctx.io.cwd, flags.media));
  const plan = buildPostPlans({
    runId: flags.run,
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
  // only the comments go through the redactor whole, as a run does when it writes post-plan.json: its digit rule
  // would break account ids and receipt URLs
  const masked = { ...plan, items: plan.items.map((item) => ({ ...item, comment: ctx.redactor.value(item.comment) })) };
  return { project, registry, runId: flags.run, runDir, results, media, plan: masked };
}

/** Prints the rebuilt post plan. */
async function reportPlan(ctx: CommandContext): Promise<ExitCode> {
  const { plan } = await rebuildPlan(ctx);
  ctx.out.result(plan, `${JSON.stringify(plan, null, 2)}\n`, "registered");
  return ExitCode.Pass;
}

/**
 * Posts the rebuilt post plan through each tracker's client, then files or comments on the bugs of regression
 * results. Exits 1 when any item or bug action failed, and 2 before posting anything when a tracker it needs has
 * no `site` or no client. `--dry-run` prints the same actions and reads no secret.
 */
async function reportPost(ctx: CommandContext): Promise<ExitCode> {
  const { project, registry, runId, runDir, results, media, plan } = await rebuildPlan(ctx);
  const { config } = project;
  const { redactor } = ctx;
  const intents = planBugs({
    results,
    config,
    renderer: (tracker) => registry.tracker(tracker),
    runDir,
    ...(media === undefined ? {} : { media }),
    redactor,
  });
  const trackers = new Set([...plan.items.map((item) => item.ticket.tracker), ...intents.map((bug) => bug.tracker)]);
  for (const tracker of trackers) trackerToPost(config, registry, tracker);
  for (const result of results) {
    const filed = result.stage === "regression" && (result.status === "fail" || result.status === "pass");
    if (filed && !intents.some((bug) => bug.caseId === result.caseId))
      ctx.out.log(
        `no bug project for ${result.caseId}: it links no ticket whose project sets bugs under trackers in ${BRAND.configFile}`,
      );
  }
  if (ctx.flags["dry-run"] === true) {
    const items = describeDirectPost(plan, config);
    const bugs = intents.map(bugIntentLine);
    ctx.out.result({ runId, dryRun: true, items, bugs }, lines([...items, ...bugs]), "registered");
    return ExitCode.Pass;
  }
  const providers = registry.secretProviders(config.secrets.providers);
  const secret = (name: string): Promise<string> => resolveSecret(name, providers, redactor);
  const { signal } = ctx.io;
  const log = (line: string): void => ctx.out.log(line);
  const items = await postPlanDirect(plan, {
    runDir,
    stateDir: join(project.root, BRAND.stateDir),
    config,
    registry,
    secret,
    redactor,
    signal,
    now: () => new Date(),
    log,
  });
  const applied = await applyBugs(intents, (tracker) =>
    registry
      .trackerClient(tracker)
      .connect({ config: trackerToPost(config, registry, tracker), secret, redactor, signal, log }),
  );
  const bugs = applied.map((bug) => (bug.error === undefined ? bug : { ...bug, error: redactor.text(bug.error) }));
  ctx.out.result({ runId, items, bugs }, lines([...items.map(itemLine), ...bugs.map(bugLine)]), "registered");
  return items.every((item) => item.ok) && bugs.every((bug) => bug.ok) ? ExitCode.Pass : ExitCode.Fail;
}

/** The tracker's config, refusing to start without its `site` or its client. */
function trackerToPost(config: ProjectConfig, registry: PluginRegistry, tracker: string): TrackerConfig {
  // tracker names come from case links
  const settings = Object.hasOwn(config.trackers, tracker) ? config.trackers[tracker] : undefined;
  if (settings?.site === undefined) {
    throw new CommandError(`cannot post to ${tracker}: trackers.${tracker}.site is not set`);
  }
  try {
    registry.trackerClient(tracker);
  } catch (error) {
    throw new CommandError(`cannot post to ${tracker}: ${(error as Error).message}`);
  }
  return settings;
}

function itemLine(outcome: ItemOutcome): string {
  const { key } = outcome.ticket;
  return outcome.ok ? `posted ${key} ${outcome.url ?? ""}` : `failed ${key}: ${outcome.error ?? ""}`;
}

function bugLine(outcome: BugOutcome): string {
  if (!outcome.ok) return `failed ${outcome.caseId}: ${outcome.action}: ${outcome.error ?? ""}`;
  return `${outcome.caseId}: ${outcome.action}${outcome.url === undefined ? "" : ` ${outcome.url}`}`;
}

function bugIntentLine(intent: BugIntent): string {
  const head = `${intent.tracker}:${intent.project} ${intent.caseId}: comment on the open bug labelled ${intent.label}`;
  if (intent.kind === "file") return `${head}, or file "${intent.draft.summary}"`;
  return intent.transition === undefined ? head : `${head} and move it to ${intent.transition}`;
}

function lines(text: readonly string[]): string {
  return text.map((line) => `${line}\n`).join("");
}

/** Records the comment URL for the item the marker names, so the next plan for that case and ticket edits it. */
async function reportAck(ctx: CommandContext): Promise<ExitCode> {
  const { flags } = ctx;
  const [, marker] = ctx.args;
  if (marker === undefined) throw new CommandError("name the marker of the item that was posted");
  if (flags.url === undefined) throw new CommandError("--url is required: the URL of the posted comment");
  if (!URL.canParse(flags.url)) throw new CommandError(`--url "${flags.url}" is not a URL`);
  const runId = flags.run ?? runIdOf(marker);
  const plan = await readPostPlan(runDirOf(ctx.root, runId));
  const item = itemFor(plan, marker, flags.ticket);
  await recordReceipt(join(ctx.root, BRAND.stateDir), item, flags.url, new Date());
  const ticket = `${item.ticket.tracker}:${item.ticket.key}`;
  ctx.out.result({ marker, ticket, caseId: item.caseId }, `recorded the comment for ${marker} on ${ticket}\n`);
  return ExitCode.Pass;
}

/** The results of the run's cases in the order they started; the preflight, prompts and answers folders hold no case. */
async function readResults(runDir: string): Promise<CaseResult[]> {
  let entries;
  try {
    entries = await readdir(runDir, { withFileTypes: true });
  } catch (error) {
    throw new CommandError(`cannot read the run folder ${runDir}: ${(error as Error).message}`);
  }
  const results: CaseResult[] = [];
  for (const entry of entries.filter((e) => e.isDirectory() && CASE_ID.test(e.name))) {
    const text = await readFile(join(runDir, entry.name, "result.json"), "utf8").catch(ignoreMissing);
    if (text !== undefined) results.push(JSON.parse(text) as CaseResult);
  }
  return results.sort((a, b) => a.startedAt.localeCompare(b.startedAt) || a.caseId.localeCompare(b.caseId));
}

async function readMedia(file: string): Promise<MediaRefs> {
  let json: unknown;
  try {
    json = JSON.parse(await readFile(file, "utf8"));
  } catch (error) {
    throw new CommandError(`cannot read the media references in ${file}: ${(error as Error).message}`);
  }
  const parsed = MediaRefs.safeParse(json);
  if (parsed.success) return parsed.data;
  const problems = parsed.error.issues.map((issue) => `${issue.path.join(".") || "(top)"}: ${issue.message}`);
  throw new CommandError(`${file} does not hold media references:\n${problems.join("\n")}`);
}

async function readPostPlan(runDir: string): Promise<PostPlan> {
  const file = join(runDir, "post-plan.json");
  let plan: Partial<PostPlan>;
  try {
    plan = JSON.parse(await readFile(file, "utf8")) as Partial<PostPlan>;
  } catch (error) {
    throw new CommandError(`cannot read ${file}: ${(error as Error).message}`);
  }
  if (!Array.isArray(plan.items)) throw new CommandError(`${file} has no items`);
  return plan as PostPlan;
}

// `<prefix>:<case-id>:<run-id>`, as buildPostPlans writes it
function runIdOf(marker: string): string {
  const [prefix, caseId, runId, ...rest] = marker.split(":");
  if (prefix !== BRAND.markerPrefix || caseId === undefined || !CASE_ID.test(caseId) || !runId || rest.length > 0) {
    throw new CommandError(`"${marker}" is not a marker; one looks like ${BRAND.markerPrefix}:<case-id>:<run-id>`);
  }
  return runId;
}

/** A case with several links posts one item per ticket under one marker, so --ticket picks among them. */
function itemFor(plan: PostPlan, marker: string, ticket: string | undefined): PostPlanItem {
  const items = plan.items.filter(
    (item) =>
      item.marker === marker && (ticket === undefined || `${item.ticket.tracker}:${item.ticket.key}` === ticket),
  );
  const [item, ...others] = items;
  if (item === undefined) {
    throw new CommandError(`run ${plan.runId} has no item ${marker}${ticket === undefined ? "" : ` for ${ticket}`}`);
  }
  if (others.length > 0) {
    const tickets = items.map((i) => `${i.ticket.tracker}:${i.ticket.key}`).join(", ");
    throw new CommandError(`several items share ${marker}; pass --ticket with one of ${tickets}`);
  }
  return item;
}

function ignoreMissing(error: unknown): undefined {
  if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
  throw error;
}
