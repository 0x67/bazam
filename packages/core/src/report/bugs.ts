import { BRAND } from "../brand.ts";
import type { ProjectConfig, TrackerConfig } from "../project.ts";
import type { Redactor } from "../redact/index.ts";
import type { CaseResult } from "../result/index.ts";
import type { BugDraft, TrackerConnection } from "./client.ts";
import { runFile } from "./direct.ts";
import {
  ticketRef,
  trackerProject,
  type MediaRefs,
  type RenderedComment,
  type TicketRef,
  type TrackerRenderer,
} from "./post-plan.ts";

type TrackerProject = TrackerConfig["projects"][string];

/** A failing regression case files a bug or comments on its open one; a passing one comments on its open bug. */
export type BugIntent =
  | {
      kind: "file";
      caseId: string;
      tracker: string;
      project: string;
      label: string;
      draft: BugDraft;
      comment: RenderedComment;
    }
  | {
      kind: "recover";
      caseId: string;
      tracker: string;
      project: string;
      label: string;
      comment: RenderedComment;
      transition?: string;
    };

export interface BugInputs {
  results: readonly CaseResult[];
  config: ProjectConfig;
  renderer(tracker: string): TrackerRenderer;
  runDir: string;
  media?: MediaRefs;
  /** Masks every intent, so a value registered after the run still applies. */
  redactor: Redactor;
}

/** `error` is not masked; it is masked where it is printed. */
export interface BugOutcome {
  caseId: string;
  ok: boolean;
  action: string;
  key?: string;
  url?: string;
  error?: string;
}

/** The label that marks a case's bug, so a search finds it exactly. */
export function bugLabel(caseId: string): string {
  return `${BRAND.markerPrefix}-${caseId}`;
}

/**
 * One intent per regression result that fails or passes, in the first linked project whose entry under
 * `trackers.<tracker>.projects` sets `bugs`. Blocked and follow-up results get none, since neither says the
 * product broke.
 */
export function planBugs(inputs: BugInputs): BugIntent[] {
  const { config, redactor } = inputs;
  return inputs.results.flatMap((result): BugIntent[] => {
    if (result.stage !== "regression" || (result.status !== "fail" && result.status !== "pass")) return [];
    const home = bugHome(config, result.links);
    if (home === undefined) return [];
    const { ref, bugs } = home;
    const target = {
      caseId: result.caseId,
      tracker: ref.tracker,
      project: trackerProject(ref.key),
      label: bugLabel(result.caseId),
    };
    const comment = redactor.value(inputs.renderer(ref.tracker).render(result, inputs.media));
    if (result.status === "pass")
      return [
        { kind: "recover", ...target, comment, ...(bugs.onPass === undefined ? {} : { transition: bugs.onPass }) },
      ];
    const draft: BugDraft = {
      project: target.project,
      issueType: bugs.issueType,
      summary: redactor.text(`[${result.caseId}] ${result.title} fails in ${result.env}`),
      labels: [...bugs.labels, target.label],
      description: comment,
      attachments: result.attachments.flatMap((name) => runFile(inputs.runDir, `${result.caseId}/${name}`) ?? []),
      relatesTo: result.links
        .map(ticketRef)
        .filter((link) => link.tracker === ref.tracker && projectOf(config, link) !== undefined)
        .map((link) => link.key),
    };
    return [{ kind: "file", ...target, draft, comment }];
  });
}

// the first link whose project sets `bugs`, in link order
function bugHome(
  config: ProjectConfig,
  links: readonly string[],
): { ref: TicketRef; bugs: NonNullable<TrackerProject["bugs"]> } | undefined {
  for (const ref of links.map(ticketRef)) {
    const bugs = projectOf(config, ref)?.bugs;
    if (bugs !== undefined) return { ref, bugs };
  }
  return undefined;
}

// the project's entry when its tracker config lists it
function projectOf(config: ProjectConfig, ref: TicketRef): TrackerProject | undefined {
  const tracker = Object.hasOwn(config.trackers, ref.tracker) ? config.trackers[ref.tracker] : undefined;
  const project = trackerProject(ref.key);
  return tracker !== undefined && Object.hasOwn(tracker.projects, project) ? tracker.projects[project] : undefined;
}

/**
 * Runs each intent against its tracker's open bug, found by the case label right before acting: a failure comments
 * on it or files one, and a pass comments on it and applies the transition. A failed intent does not stop the rest.
 */
export async function applyBugs(
  intents: readonly BugIntent[],
  connect: (tracker: string) => Promise<TrackerConnection>,
): Promise<BugOutcome[]> {
  const connections = new Map<string, Promise<TrackerConnection>>();
  const connection = (tracker: string): Promise<TrackerConnection> => {
    let connecting = connections.get(tracker);
    if (connecting === undefined) {
      // async, so a connect that throws at once fails the intents like one that rejects
      connecting = (async () => connect(tracker))();
      connections.set(tracker, connecting);
    }
    return connecting;
  };
  const outcomes: BugOutcome[] = [];
  for (const intent of intents) outcomes.push(await applyBug(intent, connection(intent.tracker)));
  return outcomes;
}

async function applyBug(intent: BugIntent, connecting: Promise<TrackerConnection>): Promise<BugOutcome> {
  const outcome: BugOutcome = {
    caseId: intent.caseId,
    ok: false,
    action: `search ${intent.project} for ${intent.label}`,
  };
  try {
    const connection = await connecting;
    const key = await connection.findOpenBug(intent.project, intent.label);
    if (key === undefined) {
      if (intent.kind === "recover") return { ...outcome, ok: true, action: `no open bug in ${intent.project}` };
      outcome.action = `file a bug in ${intent.project}`;
      const bug = await connection.createBug(intent.draft);
      const filed = { ...outcome, action: `filed ${bug.key}`, key: bug.key, url: bug.url };
      // the bug exists, so the outcome names it even when a later step failed
      if (bug.problems !== undefined && bug.problems.length > 0) return { ...filed, error: bug.problems.join("; ") };
      return { ...filed, ok: true };
    }
    outcome.key = key;
    outcome.action = `comment on ${key}`;
    outcome.url = (await connection.postComment(key, intent.comment, [])).url;
    outcome.action = `commented on ${key}`;
    if (intent.kind === "recover" && intent.transition !== undefined) {
      await connection.transition(key, intent.transition);
      outcome.action = `commented on ${key} and moved it to ${intent.transition}`;
    }
    outcome.ok = true;
  } catch (error) {
    outcome.error = error instanceof Error ? error.message : String(error);
  }
  return outcome;
}
