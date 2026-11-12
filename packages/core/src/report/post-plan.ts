import { z } from "zod";
import type { JsonValue } from "../auth/index.ts";
import { BRAND } from "../brand.ts";
import { stagePolicy, type CaseSpec } from "../case/index.ts";
import type { CaseResult, Status } from "../result/index.ts";
import type { PeopleRegistry } from "./people.ts";
import type { Receipts } from "./receipts.ts";

export interface TicketRef {
  tracker: string;
  key: string;
}

export interface PostPlanItem {
  /** `<markerPrefix>:<case-id>:<run-id>` */
  marker: string;
  ticket: TicketRef;
  caseId: string;
  status: Status;
  comment: RenderedComment;
  /** The comment to edit instead of posting a new one, from a receipt when the case sets `report.comment: update`. */
  edit?: { url: string };
  /** Paths relative to the run directory. */
  attachments: string[];
  /** Attachments left out of `attachments` because they hold a fixture, secret or credential value. */
  withheld?: { attachment: string; kinds: string[] }[];
  transition?: string;
  mentions: { role: string; accountId?: string }[];
  /** Roles (`role:<name>`) and transitions (`transition:<status>`) the agent must look up. */
  unresolved: string[];
}

export interface PostPlan {
  runId: string;
  env: string;
  createdAt: string;
  items: PostPlanItem[];
}

/** Media the agent uploaded to the tracker first, keyed by attachment path relative to the run directory. */
export const MediaRefs = z.record(
  z.string().min(1),
  z.strictObject({ id: z.string().min(1), collection: z.string().min(1).optional() }),
);
export type MediaRefs = z.infer<typeof MediaRefs>;

/** Default transition names by tracker, tracker project and status, as the config's `trackers` block holds them. */
export type TransitionMap = Readonly<
  Record<
    string,
    { projects: Readonly<Record<string, { transitions: Partial<Record<Status, string>> }>> }
  >
>;

/** One result as a tracker comment; `adf` is the Atlassian Document Format body, for Jira. */
export interface RenderedComment {
  markdown: string;
  html?: string;
  adf?: JsonValue;
}

export interface RenderOptions {
  media?: MediaRefs | undefined;
  /** The tracker's result line template; the default line when left out. */
  resultLine?: string | undefined;
}

export interface TrackerRenderer {
  tracker: string;
  render(result: CaseResult, options?: RenderOptions): RenderedComment;
}

export interface PostPlanInputs {
  runId: string;
  env: string;
  results: readonly CaseResult[];
  /** By case id. */
  specs: ReadonlyMap<string, CaseSpec>;
  people: PeopleRegistry;
  receipts: Receipts;
  trackers: (name: string) => TrackerRenderer;
  transitions: TransitionMap;
  media?: MediaRefs;
  /** The result line template of a tracker, if its config sets one. */
  resultLine?: (tracker: string) => string | undefined;
  /** The kinds of value each attachment holds, by `<case-id>/<file>`; those attachments stay out of the plan. */
  withheld?: ReadonlyMap<string, readonly string[]>;
  now: Date;
}

/** One item per linked ticket of each result whose stage posts its status. */
export function buildPostPlans(inputs: PostPlanInputs): PostPlan {
  return {
    runId: inputs.runId,
    env: inputs.env,
    createdAt: inputs.now.toISOString(),
    items: inputs.results.flatMap((result) =>
      stagePolicy(result.stage).postsOn.includes(result.status)
        ? result.links.map((link) => postPlanItem(result, ticketRef(link), inputs))
        : [],
    ),
  };
}

function postPlanItem(result: CaseResult, ticket: TicketRef, inputs: PostPlanInputs): PostPlanItem {
  // the stage and links come from the result, so a case promoted or edited after the run still reports what ran;
  // only the report settings come from the current spec
  const report = inputs.specs.get(result.caseId)?.report;
  const action = report?.on[result.status];
  const mentions = (action?.mention ?? []).map((mention) => {
    const role = mention.replace(/^role:/, "");
    const accountId = inputs.people.accountId(role, ticket.tracker);
    return { role, ...(accountId === undefined ? {} : { accountId }) };
  });
  // a configured project without the status means no transition; a project missing from the config cannot be mapped
  const projects = ownEntry(inputs.transitions, ticket.tracker)?.projects;
  const project =
    projects === undefined ? undefined : ownEntry(projects, trackerProject(ticket.key));
  const transition = action?.transition ?? project?.transitions[result.status];
  const receipt =
    report?.comment === "update"
      ? inputs.receipts.latest(ticket.tracker, ticket.key, result.caseId)
      : undefined;
  const held = (name: string) => inputs.withheld?.get(`${result.caseId}/${name}`);
  const kept = result.attachments.filter((name) => held(name) === undefined);
  const withheld = result.attachments.flatMap((name) => {
    const kinds = held(name);
    return kinds === undefined
      ? []
      : [{ attachment: `${result.caseId}/${name}`, kinds: [...kinds] }];
  });
  return {
    marker: `${BRAND.markerPrefix}:${result.caseId}:${result.runId}`,
    ticket,
    caseId: result.caseId,
    status: result.status,
    comment: inputs
      .trackers(ticket.tracker)
      .render(
        { ...result, attachments: kept },
        { media: inputs.media, resultLine: inputs.resultLine?.(ticket.tracker) },
      ),
    ...(receipt === undefined ? {} : { edit: { url: receipt.url } }),
    attachments: kept.map((name) => `${result.caseId}/${name}`),
    ...(withheld.length === 0 ? {} : { withheld }),
    ...(transition === undefined ? {} : { transition }),
    mentions,
    unresolved: [
      ...mentions
        .filter((mention) => mention.accountId === undefined)
        .map((mention) => `role:${mention.role}`),
      ...(action?.transition === undefined && project === undefined
        ? [`transition:${result.status}`]
        : []),
    ],
  };
}

// tracker and project names come from case links, where a name such as constructor must not reach an inherited member
function ownEntry<T>(record: Readonly<Record<string, T>>, key: string): T | undefined {
  return Object.hasOwn(record, key) ? record[key] : undefined;
}

// a Jira key DEMO-246 belongs to project DEMO
export function trackerProject(key: string): string {
  return key.replace(/-\d+$/, "");
}

// links are validated as `<tracker>:<key>` when the case loads
export function ticketRef(link: string): TicketRef {
  const colon = link.indexOf(":");
  return { tracker: link.slice(0, colon), key: link.slice(colon + 1) };
}
