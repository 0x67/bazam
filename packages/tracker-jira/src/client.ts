import { openAsBlob } from "node:fs";
import type { JsonValue } from "@bazam/core/auth";
import {
  trackerHttp,
  trackerPath,
  type AttachmentFile,
  type BugDraft,
  type Mention,
  type PostedComment,
  type RenderedComment,
  type TicketState,
  type TrackerClient,
  type TrackerClientContext,
  type TrackerConnection,
  type TrackerHttp,
} from "@bazam/core/report";

const ISSUE_KEY = /^[A-Z][A-Z0-9_]*-[1-9][0-9]*$/;
const PROJECT_KEY = /^[A-Z][A-Z0-9_]*$/;
const COMMENT_ID = /^[0-9]+$/;
const SCOPED_API = /^https:\/\/api\.atlassian\.com\/ex\/jira\/[^/?#]+\/?$/;
const REST_COMMENT_PATH = /\/rest\/api\/\d+\/issue\/[^/]+\/comment\/([^/]+)$/;
const LOOPBACK_HOSTS: ReadonlySet<string> = new Set(["127.0.0.1", "localhost"]);
// Jira takes 60 files per request; smaller batches keep each upload short
const FILES_PER_REQUEST = 10;

/** Jira Cloud REST v3 with basic auth; REST calls go to `api` when set, browse links always use `site`. */
export const jiraClient: TrackerClient = {
  tracker: "jira",
  async connect(ctx) {
    const { site, api, secrets, projects } = ctx.config;
    if (site === undefined) throw new Error("trackers.jira.site is not set");
    if (api !== undefined && !SCOPED_API.test(new URL(api).href) && !isLoopback(new URL(api)))
      throw new Error(
        "trackers.jira.api must be https://api.atlassian.com/ex/jira/<cloudId>; http only for 127.0.0.1 or localhost with a port",
      );
    for (const project of Object.keys(projects))
      if (!PROJECT_KEY.test(project))
        throw new Error(
          `trackers.jira.projects lists ${project}, which is not a Jira project key: capital letters, digits and underscores, starting with a letter`,
        );
    const emailName = secrets["email"];
    const tokenName = secrets["token"];
    if (emailName === undefined) throw new Error("trackers.jira.secrets.email is not set");
    if (tokenName === undefined) throw new Error("trackers.jira.secrets.token is not set");
    const email = await ctx.secret(emailName);
    const token = await ctx.secret(tokenName);
    // tests serve the stub on loopback http
    const siteUrl = new URL(`${isLoopback(new URL(`http://${site}`)) ? "http" : "https"}://${site}`);
    const http = trackerHttp({
      base: api === undefined ? siteUrl : new URL(api),
      authorization: `Basic ${Buffer.from(`${email}:${token}`, "utf8").toString("base64")}`,
      redactor: ctx.redactor,
      signal: ctx.signal,
      log: (line) => ctx.log(line),
    });
    return new JiraConnection(http, siteUrl, ctx);
  },
};

class JiraConnection implements TrackerConnection {
  readonly #http: TrackerHttp;
  readonly #site: URL;
  readonly #ctx: TrackerClientContext;
  #linkTypes: string[] | undefined;

  constructor(http: TrackerHttp, site: URL, ctx: TrackerClientContext) {
    this.#http = http;
    this.#site = site;
    this.#ctx = ctx;
  }

  async ticket(key: string): Promise<TicketState> {
    checkKey(key);
    const path = trackerPath`/rest/api/3/issue/${key}`;
    const { body } = await this.#http.send({ method: "GET", path, query: { fields: "status,assignee,reporter" } });
    const status = at(body, "fields", "status", "name");
    if (typeof status !== "string") throw new Error(`GET ${path} answered without fields.status.name`);
    const assignee = at(body, "fields", "assignee", "accountId");
    const reporter = at(body, "fields", "reporter", "accountId");
    return {
      key,
      status,
      done: at(body, "fields", "status", "statusCategory", "key") === "done",
      ...(typeof assignee === "string" ? { assignee } : {}),
      ...(typeof reporter === "string" ? { reporter } : {}),
    };
  }

  async attach(key: string, files: readonly AttachmentFile[]): Promise<void> {
    checkKey(key);
    for (let start = 0; start < files.length; start += FILES_PER_REQUEST) {
      const form = new FormData();
      for (const file of files.slice(start, start + FILES_PER_REQUEST))
        form.append("file", await openAsBlob(file.path), file.name);
      await this.#http.send({
        method: "POST",
        path: trackerPath`/rest/api/3/issue/${key}/attachments`,
        form,
        headers: { "X-Atlassian-Token": "no-check" },
      });
    }
  }

  async postComment(key: string, comment: RenderedComment, mentions: readonly Mention[]): Promise<PostedComment> {
    checkKey(key);
    const path = trackerPath`/rest/api/3/issue/${key}/comment`;
    const { body } = await this.#http.send({ method: "POST", path, json: { body: withMentions(comment, mentions) } });
    const id = at(body, "id");
    if (typeof id !== "string" || !COMMENT_ID.test(id)) throw new Error(`POST ${path} answered without a comment id`);
    return { url: this.#browse(key, id) };
  }

  async editComment(
    key: string,
    url: string,
    comment: RenderedComment,
    mentions: readonly Mention[],
  ): Promise<PostedComment | undefined> {
    checkKey(key);
    const id = commentId(url);
    if (id === undefined) return undefined;
    await this.#http.send({
      method: "PUT",
      path: trackerPath`/rest/api/3/issue/${key}/comment/${id}`,
      json: { body: withMentions(comment, mentions) },
    });
    return { url: this.#browse(key, id) };
  }

  async transition(key: string, name: string): Promise<void> {
    checkKey(key);
    const path = trackerPath`/rest/api/3/issue/${key}/transitions`;
    const { body } = await this.#http.send({ method: "GET", path });
    const transitions = arrayAt(body, "transitions");
    const named = (value: unknown): boolean => typeof value === "string" && value.toLowerCase() === name.toLowerCase();
    const chosen =
      transitions.find((transition) => named(at(transition, "name"))) ??
      transitions.find((transition) => named(at(transition, "to", "name")));
    const id = at(chosen, "id");
    if (typeof id !== "string") {
      const names = transitions
        .map((transition) => at(transition, "name"))
        .filter((value) => typeof value === "string");
      throw new Error(
        `transition ${name} is not available on ${key}; it offers ${names.length === 0 ? "none" : names.join(", ")}`,
      );
    }
    await this.#http.send({ method: "POST", path, json: { transition: { id } } });
  }

  async findOpenBug(project: string, label: string): Promise<string | undefined> {
    const jql = `project = "${jqlString(project)}" AND labels = "${jqlString(label)}" AND statusCategory != Done ORDER BY created DESC`;
    const { body } = await this.#http.send({
      method: "POST",
      path: "/rest/api/3/search/jql",
      json: { jql, fields: ["created"], maxResults: 1 },
    });
    const key = at(arrayAt(body, "issues")[0], "key");
    return typeof key === "string" ? key : undefined;
  }

  async createBug(draft: BugDraft): Promise<{ key: string; url: string }> {
    for (const key of draft.relatesTo) checkKey(key);
    const path = "/rest/api/3/issue";
    const { body } = await this.#http.send({
      method: "POST",
      path,
      json: {
        fields: {
          project: { key: draft.project },
          issuetype: { name: draft.issueType },
          summary: draft.summary,
          description: adfOf(draft.description),
          labels: draft.labels,
        },
      },
    });
    const bug = at(body, "key");
    if (typeof bug !== "string" || !ISSUE_KEY.test(bug)) throw new Error(`POST ${path} answered without an issue key`);
    await this.attach(bug, draft.attachments);
    if (draft.relatesTo.length > 0) await this.#link(bug, draft.project, draft.relatesTo);
    return { key: bug, url: this.#browse(bug) };
  }

  // admins can rename link types, so the configured name is checked against the site's link types, fetched once per connection
  async #link(bug: string, project: string, keys: readonly string[]): Promise<void> {
    const name = this.#ctx.config.projects[project]?.bugs?.linkType ?? "Relates";
    this.#linkTypes ??= arrayAt(
      (await this.#http.send({ method: "GET", path: "/rest/api/3/issueLinkType" })).body,
      "issueLinkTypes",
    )
      .map((type) => at(type, "name"))
      .filter((type) => typeof type === "string");
    if (!this.#linkTypes.includes(name)) {
      this.#ctx.log(
        `no issue link type named ${name}, so ${bug} is not linked to ${keys.join(", ")}; set trackers.jira.projects.${project}.bugs.linkType to a link type the site has`,
      );
      return;
    }
    for (const key of keys)
      await this.#http.send({
        method: "POST",
        path: "/rest/api/3/issueLink",
        json: { type: { name }, inwardIssue: { key: bug }, outwardIssue: { key } },
      });
  }

  #browse(key: string, commentId?: string): string {
    const url = new URL(trackerPath`/browse/${key}`, this.#site);
    if (commentId !== undefined) url.searchParams.set("focusedCommentId", commentId);
    return url.href;
  }
}

function isLoopback(url: URL): boolean {
  return url.protocol === "http:" && LOOPBACK_HOSTS.has(url.hostname) && url.port !== "";
}

function checkKey(key: string): void {
  if (!ISSUE_KEY.test(key)) throw new Error(`${key} is not a Jira issue key`);
}

// a browse URL's focusedCommentId or the last segment of a REST comment URL; anything else names no comment
function commentId(url: string): string | undefined {
  if (!URL.canParse(url)) return undefined;
  const parsed = new URL(url);
  const id = parsed.searchParams.get("focusedCommentId") ?? REST_COMMENT_PATH.exec(parsed.pathname)?.[1];
  return id !== undefined && COMMENT_ID.test(id) ? id : undefined;
}

function adfOf(comment: RenderedComment): { [key: string]: JsonValue; content: JsonValue[] } {
  const adf = comment.adf;
  const content = at(adf, "content");
  if (typeof adf !== "object" || adf === null || Array.isArray(adf) || adf["type"] !== "doc" || !Array.isArray(content))
    throw new Error("the comment has no ADF document for Jira");
  return { ...adf, content: content as JsonValue[] };
}

// mentions go last, one paragraph, since the renderer has no account ids
function withMentions(comment: RenderedComment, mentions: readonly Mention[]): JsonValue {
  const adf = adfOf(comment);
  if (mentions.length === 0) return adf;
  const nodes = mentions.flatMap((mention, index): JsonValue[] => [
    ...(index === 0 ? [] : [{ type: "text", text: " " }]),
    { type: "mention", attrs: { id: mention.accountId, text: `@${mention.role}` } },
  ]);
  return { ...adf, content: [...adf.content, { type: "paragraph", content: nodes }] };
}

function jqlString(value: string): string {
  return value.replaceAll("\\", "\\\\").replaceAll('"', '\\"');
}

function arrayAt(value: unknown, key: string): unknown[] {
  const found = at(value, key);
  return Array.isArray(found) ? (found as unknown[]) : [];
}

// the value at the key path, or undefined once a value on the way is not an object
function at(value: unknown, ...keys: string[]): unknown {
  let current = value;
  for (const key of keys) {
    if (typeof current !== "object" || current === null) return undefined;
    current = (current as Record<string, unknown>)[key];
  }
  return current;
}
