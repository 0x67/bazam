import { readdir, readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { BRAND } from "@bazam/core/brand";
import { CASE_ID } from "@bazam/core/case";
import {
  buildPostPlans,
  loadReceipts,
  MediaRefs,
  PeopleRegistry,
  recordReceipt,
  type PostPlan,
  type PostPlanItem,
} from "@bazam/core/report";
import type { CaseResult } from "@bazam/core/result";
import { CommandError, ExitCode } from "../exit.ts";
import type { CommandContext } from "../main.ts";
import { runDirOf } from "./plan.ts";

/** `report plan` and `report ack`. */
export async function reportCommand(ctx: CommandContext): Promise<ExitCode> {
  const [action] = ctx.args;
  if (action === "plan") return reportPlan(ctx);
  if (action === "ack") return reportAck(ctx);
  throw new CommandError(`report takes plan or ack, not ${action === undefined ? "nothing" : `"${action}"`}`);
}

/**
 * Builds the run's post plan again from its results and the receipts recorded since, so an item for a case with
 * `report.comment: update` carries the comment to edit. Prints it and leaves post-plan.json as the run wrote it.
 */
async function reportPlan(ctx: CommandContext): Promise<ExitCode> {
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
  // only the comments go through the redactor whole, as the runner does: its digit rule would break account ids
  // and receipt URLs
  const masked = { ...plan, items: plan.items.map((item) => ({ ...item, comment: ctx.redactor.value(item.comment) })) };
  ctx.out.result(masked, `${JSON.stringify(masked, null, 2)}\n`, "registered");
  return ExitCode.Pass;
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

/** The results of the run's cases in the order they started; preflight, prompts and answers are no case. */
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
