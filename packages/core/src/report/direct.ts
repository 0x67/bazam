import { basename, isAbsolute, relative, resolve, sep } from "node:path";
import type { PluginRegistry } from "../plugin/index.ts";
import type { ProjectConfig, TrackerConfig } from "../project.ts";
import type { Redactor } from "../redact/index.ts";
import type {
  AttachmentFile,
  Mention,
  TicketState,
  TrackerConnection,
  UploadedMedia,
} from "./client.ts";
import {
  trackerProject,
  type PostPlan,
  type PostPlanItem,
  type RenderedComment,
  type TicketRef,
} from "./post-plan.ts";
import { recordReceipt } from "./receipts.ts";
import { TrackerRequestFailed } from "./tracker-http.ts";

const NO_COMMENT_TO_EDIT = "posted a new comment: the receipt URL names no comment to edit";

/** What happened to one post plan item; `error` is masked. */
export interface ItemOutcome {
  marker: string;
  ticket: TicketRef;
  ok: boolean;
  url?: string;
  actions: string[];
  /** Roles with no account id, as `role:<name>`. */
  unresolved: string[];
  error?: string;
}

export interface DirectPostDeps {
  runDir: string;
  stateDir: string;
  config: ProjectConfig;
  registry: PluginRegistry;
  secret(name: string): Promise<string>;
  redactor: Redactor;
  signal: AbortSignal;
  now(): Date;
  log(line: string): void;
}

/**
 * Posts each item through its tracker's client, in plan order, connecting once per tracker. An item whose
 * tracker has no `site` or whose project is not listed sends nothing; a failed item keeps its error and the
 * loop goes on. A receipt is recorded as soon as the comment is posted, so a failed transition still leaves one.
 */
export async function postPlanDirect(plan: PostPlan, deps: DirectPostDeps): Promise<ItemOutcome[]> {
  const connections = new Map<string, Promise<TrackerConnection>>();
  const connect = (tracker: string, config: TrackerConfig): Promise<TrackerConnection> => {
    let connection = connections.get(tracker);
    if (connection === undefined) {
      const { redactor, signal } = deps;
      const secret = (name: string): Promise<string> => deps.secret(name);
      const log = (line: string): void => deps.log(line);
      // async, so an unknown client rejects like a failed connect
      connection = (async () =>
        deps.registry.trackerClient(tracker).connect({ config, secret, redactor, signal, log }))();
      connections.set(tracker, connection);
    }
    return connection;
  };
  const outcomes: ItemOutcome[] = [];
  for (const item of plan.items) outcomes.push(await postItem(item, deps, connect));
  return outcomes;
}

async function postItem(
  item: PostPlanItem,
  deps: DirectPostDeps,
  connect: (tracker: string, config: TrackerConfig) => Promise<TrackerConnection>,
): Promise<ItemOutcome> {
  const { tracker, key } = item.ticket;
  const outcome: ItemOutcome = {
    marker: item.marker,
    ticket: item.ticket,
    ok: false,
    actions: [],
    unresolved: [],
  };
  const guarded = guard(item.ticket, deps.config);
  if ("refused" in guarded) return { ...outcome, error: guarded.refused };
  try {
    const files = item.attachments.map((path) => {
      const file = runFile(deps.runDir, path);
      if (file === undefined) throw new Error(`attachment ${path} is outside the run folder`);
      return file;
    });
    const connection = await connect(tracker, guarded.config);
    const state = await connection.ticket(key);
    // a moved issue answers under its new key, in a project the guard has not checked
    const moved = state.key === key ? undefined : unlistedProject(guarded.config, state.key);
    if (moved !== undefined)
      throw new Error(
        `${key} is now ${state.key}, in project ${moved}, which is not listed under trackers.${tracker}.projects`,
      );
    const mentions = resolveMentions(item, state, outcome.unresolved);
    let uploaded: UploadedMedia = new Map();
    if (files.length > 0) {
      uploaded = await connection.attach(key, files);
      outcome.actions.push(`attached ${files.map((file) => file.name).join(", ")}`);
    }
    const shown =
      uploaded.size > 0 && connection.showUploads !== undefined
        ? connection.showUploads(item.comment, uploaded)
        : item.comment;
    const posted = await commentOrPlain(connection, item, shown, mentions, outcome.actions, deps);
    outcome.url = posted;
    await recordReceipt(deps.stateDir, item, posted, deps.now());
    if (item.transition !== undefined) {
      // most workflows offer no transition from a status to itself
      if (state.status.toLowerCase() === item.transition.toLowerCase())
        outcome.actions.push(`already in ${state.status}`);
      else {
        await connection.transition(key, item.transition);
        outcome.actions.push(`moved to ${item.transition}`);
      }
    }
    outcome.ok = true;
  } catch (error) {
    outcome.error = deps.redactor.text(error instanceof Error ? error.message : String(error));
  }
  return outcome;
}

/** The file at `path` under `runDir`, or undefined when the path leads outside it. */
export function runFile(runDir: string, path: string): AttachmentFile | undefined {
  const file = resolve(runDir, path);
  const fromRun = relative(runDir, file);
  if (fromRun === ".." || fromRun.startsWith(`..${sep}`) || isAbsolute(fromRun)) return undefined;
  return { name: basename(file), path: file };
}

// the tracker answers 400 to a media id it does not accept, so inline media never costs the comment
async function commentOrPlain(
  connection: TrackerConnection,
  item: PostPlanItem,
  shown: RenderedComment,
  mentions: readonly Mention[],
  actions: string[],
  deps: DirectPostDeps,
): Promise<string> {
  try {
    // a refused edit of the media variant may only mean the tracker took a media id badly, so the plain one edits
    const url = await comment(connection, item, shown, mentions, actions);
    return url ?? (await comment(connection, item, item.comment, mentions, actions))!;
  } catch (error) {
    if (shown === item.comment || !(error instanceof TrackerRequestFailed) || error.status !== 400)
      throw error;
    deps.log(
      `the tracker refused the comment with inline images, so it is posted without them: ${error.message}`,
    );
    return (await comment(connection, item, item.comment, mentions, actions))!;
  }
}

/** The comment's URL; edits the receipt's comment when the item names one the client can edit. */
async function comment(
  connection: TrackerConnection,
  item: PostPlanItem,
  body: RenderedComment,
  mentions: readonly Mention[],
  actions: string[],
): Promise<string | undefined> {
  const { key } = item.ticket;
  if (item.edit !== undefined) {
    const edited = await connection.editComment(key, item.edit.url, body, mentions);
    if (edited !== undefined) {
      actions.push("edited the comment");
      return edited.url;
    }
    if (body !== item.comment) return undefined;
  }
  const posted = await connection.postComment(key, body, mentions);
  actions.push(item.edit === undefined ? "posted a comment" : NO_COMMENT_TO_EDIT);
  return posted.url;
}

// assignee and reporter come from the ticket, every other role from the plan
function resolveMentions(item: PostPlanItem, state: TicketState, unresolved: string[]): Mention[] {
  const mentions: Mention[] = [];
  for (const { role, accountId } of item.mentions) {
    const id =
      role === "assignee" ? state.assignee : role === "reporter" ? state.reporter : accountId;
    if (id === undefined) unresolved.push(`role:${role}`);
    else mentions.push({ role, accountId: id });
  }
  return mentions;
}

// a link names its tracker and project, so a typo must not reach another site or another team's project
function guard(
  ticket: TicketRef,
  config: ProjectConfig,
): { config: TrackerConfig } | { refused: string } {
  const tracker = Object.hasOwn(config.trackers, ticket.tracker)
    ? config.trackers[ticket.tracker]
    : undefined;
  if (tracker?.site === undefined) return { refused: `trackers.${ticket.tracker}.site is not set` };
  const project = unlistedProject(tracker, ticket.key);
  if (project !== undefined)
    return {
      refused: `project ${project} is not listed under trackers.${ticket.tracker}.projects`,
    };
  return { config: tracker };
}

// the key's project when `projects` does not list it
function unlistedProject(tracker: TrackerConfig, key: string): string | undefined {
  const project = trackerProject(key);
  return Object.hasOwn(tracker.projects, project) ? undefined : project;
}

/** What `postPlanDirect` would do, one line per action, with the items the guard refuses. */
export function describeDirectPost(plan: PostPlan, config: ProjectConfig): string[] {
  return plan.items.flatMap((item) => {
    const ticket = `${item.ticket.tracker}:${item.ticket.key}`;
    const guarded = guard(item.ticket, config);
    if ("refused" in guarded) return [`${ticket} fails: ${guarded.refused}`];
    const roles = item.mentions.map((mention) => mention.role);
    const comment = `the ${item.status} comment for ${item.caseId}${roles.length === 0 ? "" : `, mentioning ${roles.join(", ")}`}`;
    const files = item.attachments.map((path) => basename(path));
    return [
      `${ticket} read the ticket`,
      ...(files.length === 0 ? [] : [`${ticket} attach ${files.join(", ")}`]),
      item.edit === undefined
        ? `${ticket} post ${comment}`
        : `${ticket} edit ${comment} at ${item.edit.url}`,
      ...(item.transition === undefined ? [] : [`${ticket} move to ${item.transition}`]),
    ];
  });
}
