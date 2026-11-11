import {
  createServer,
  type IncomingHttpHeaders,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import type { AddressInfo } from "node:net";

/** Jira's status category keys. */
export type StatusCategory = "new" | "indeterminate" | "done";

export interface StubTransition {
  id: string;
  name: string;
  /** The status the transition moves to. */
  to: string;
  /** `indeterminate` when left out. */
  category?: StatusCategory;
}

export interface StubComment {
  id: string;
  body: unknown;
  /** Refuses an edit with 400, as Jira does for an account without permission to edit the comment. */
  readOnly?: boolean;
}

export interface StubAttachment {
  name: string;
  size: number;
}

/** An issue the test seeds or the client creates; the stub adds comments and attachments as they arrive. */
export interface StubIssue {
  key: string;
  status: string;
  /** `new` when left out. */
  category?: StatusCategory;
  /** An account id. */
  assignee?: string;
  /** An account id. */
  reporter?: string;
  labels?: string[];
  transitions?: StubTransition[];
  comments?: StubComment[];
  attachments?: StubAttachment[];
  // set on an issue the client created
  issueType?: string;
  summary?: string;
  description?: unknown;
}

export interface StubLink {
  type: string;
  inward: string;
  outward: string;
}

/**
 * `path` is the URL path with any base path; `query` holds the search parameters; `body` is the parsed JSON,
 * or the files of a multipart upload.
 */
export interface StubRequest {
  method: string;
  path: string;
  query: Record<string, string>;
  body: unknown;
}

export interface JiraStub {
  /** `127.0.0.1:<port>`. */
  site: string;
  /** In creation order, which the search reads as `created`. */
  issues: Map<string, StubIssue>;
  links: StubLink[];
  requests: StubRequest[];
  close(): Promise<void>;
}

export interface JiraStubOptions {
  email: string;
  token: string;
  issues?: StubIssue[];
  /** Relates and Blocks when left out. */
  linkTypes?: string[];
}

interface Answer {
  status: number;
  body?: unknown;
}

const NO_ISSUE: Answer = {
  status: 404,
  body: { errorMessages: ["Issue does not exist or you do not have permission to see it."] },
};
// the one JQL shape the client sends, with its quoted values
const OPEN_BUG_JQL =
  /^project = "((?:[^"\\]|\\.)*)" AND labels = "((?:[^"\\]|\\.)*)" AND statusCategory != Done ORDER BY created DESC$/;

/**
 * Serves the Jira Cloud REST v3 endpoints the client calls on 127.0.0.1, under any `/ex/jira/<cloudId>` base
 * path. It answers 401 without the expected basic header and records every request, answered or not.
 */
export async function startJiraStub(options: JiraStubOptions): Promise<JiraStub> {
  const authorization = `Basic ${Buffer.from(`${options.email}:${options.token}`, "utf8").toString("base64")}`;
  const linkTypes = options.linkTypes ?? ["Relates", "Blocks"];
  const issues = new Map((options.issues ?? []).map((issue) => [issue.key, issue]));
  const links: StubLink[] = [];
  const requests: StubRequest[] = [];
  let lastId = 10_000;

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    const method = req.method ?? "GET";
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    const body = await readBody(Buffer.concat(chunks), req.headers["content-type"]);
    requests.push({
      method,
      path: url.pathname,
      query: Object.fromEntries(url.searchParams),
      body,
    });
    const answer =
      req.headers.authorization === authorization
        ? route(method, url.pathname.replace(/^\/ex\/jira\/[^/]+/, ""), body, req.headers)
        : {
            status: 401,
            body: { errorMessages: ["Client must be authenticated to access this resource."] },
          };
    if (answer.body === undefined) res.writeHead(answer.status).end();
    else
      res
        .writeHead(answer.status, { "content-type": "application/json" })
        .end(JSON.stringify(answer.body));
  }

  function route(
    method: string,
    path: string,
    body: unknown,
    headers: IncomingHttpHeaders,
  ): Answer {
    if (method === "POST" && path === "/rest/api/3/search/jql") return search(body);
    if (method === "POST" && path === "/rest/api/3/issue") return create(body);
    if (method === "GET" && path === "/rest/api/3/issueLinkType")
      return {
        status: 200,
        body: { issueLinkTypes: linkTypes.map((name, index) => ({ id: `${index + 1}`, name })) },
      };
    if (method === "POST" && path === "/rest/api/3/issueLink") return link(body);
    const match =
      /^\/rest\/api\/3\/issue\/([^/]+)(?:\/(attachments|comment|transitions)(?:\/([^/]+))?)?$/.exec(
        path,
      );
    if (match === null)
      return {
        status: 404,
        body: { errorMessages: [`the stub does not serve ${method} ${path}`] },
      };
    const [, key = "", resource = "", id] = match;
    const issue = issues.get(decodeURIComponent(key));
    if (issue === undefined) return NO_ISSUE;
    switch (`${method} ${resource}${id === undefined ? "" : "/{id}"}`) {
      case "GET ":
        return { status: 200, body: issueBody(issue) };
      case "POST attachments":
        return attach(issue, body, headers);
      case "POST comment":
        return comment(issue, body);
      case "PUT comment/{id}":
        return editComment(issue, decodeURIComponent(id ?? ""), body);
      case "GET transitions":
        return {
          status: 200,
          body: { transitions: (issue.transitions ?? []).map(transitionBody) },
        };
      case "POST transitions":
        return transition(issue, body);
      default:
        return {
          status: 405,
          body: { errorMessages: [`the stub does not serve ${method} ${path}`] },
        };
    }
  }

  function search(body: unknown): Answer {
    const match = OPEN_BUG_JQL.exec(String(field(body, "jql")));
    if (match === null)
      return {
        status: 400,
        body: { errorMessages: ["the stub evaluates only the open bug query"] },
      };
    const [project, label] = [match[1] ?? "", match[2] ?? ""].map((value) =>
      value.replace(/\\(.)/g, "$1"),
    );
    const max = field(body, "maxResults");
    const found = [...issues.values()]
      .reverse()
      .filter(
        (issue) =>
          projectOf(issue.key) === project &&
          (issue.labels ?? []).includes(label ?? "") &&
          (issue.category ?? "new") !== "done",
      )
      .slice(0, typeof max === "number" ? max : 50);
    return { status: 200, body: { issues: found.map((issue) => ({ key: issue.key })) } };
  }

  function create(body: unknown): Answer {
    const project = field(body, "fields", "project", "key");
    const summary = field(body, "fields", "summary");
    if (typeof project !== "string" || typeof summary !== "string")
      return { status: 400, body: { errors: { project: "project and summary are required" } } };
    const numbers = [...issues.keys()]
      .filter((key) => projectOf(key) === project)
      .map((key) => issueNumber(key));
    const key = `${project}-${Math.max(0, ...numbers) + 1}`;
    const labels = field(body, "fields", "labels");
    const issueType = field(body, "fields", "issuetype", "name");
    issues.set(key, {
      key,
      status: "To Do",
      category: "new",
      labels: Array.isArray(labels) ? labels.filter((label) => typeof label === "string") : [],
      summary,
      ...(typeof issueType === "string" ? { issueType } : {}),
      description: field(body, "fields", "description"),
    });
    return { status: 201, body: { id: `${(lastId += 1)}`, key } };
  }

  function link(body: unknown): Answer {
    const type = field(body, "type", "name");
    const inward = field(body, "inwardIssue", "key");
    const outward = field(body, "outwardIssue", "key");
    if (typeof type !== "string" || !linkTypes.includes(type))
      return {
        status: 404,
        body: { errorMessages: [`No issue link type with name '${String(type)}' found.`] },
      };
    if (
      typeof inward !== "string" ||
      typeof outward !== "string" ||
      !issues.has(inward) ||
      !issues.has(outward)
    )
      return NO_ISSUE;
    links.push({ type, inward, outward });
    return { status: 201 };
  }

  function attach(issue: StubIssue, body: unknown, headers: IncomingHttpHeaders): Answer {
    if (headers["x-atlassian-token"] !== "no-check")
      return { status: 403, body: { errorMessages: ["XSRF check failed"] } };
    if (!Array.isArray(body) || body.length === 0)
      return { status: 400, body: { errorMessages: ["the request holds no file part"] } };
    const files = body as StubAttachment[];
    (issue.attachments ??= []).push(...files);
    return {
      status: 200,
      body: files.map((file) => ({ id: `${(lastId += 1)}`, filename: file.name, size: file.size })),
    };
  }

  function comment(issue: StubIssue, body: unknown): Answer {
    const posted = { id: `${(lastId += 1)}`, body: field(body, "body") };
    (issue.comments ??= []).push(posted);
    return { status: 201, body: posted };
  }

  function editComment(issue: StubIssue, id: string, body: unknown): Answer {
    const found = issue.comments?.find((existing) => existing.id === id);
    if (found === undefined)
      return {
        status: 404,
        body: { errorMessages: [`Can not find a comment for the id: ${id}.`] },
      };
    if (found.readOnly === true)
      return {
        status: 400,
        body: { errorMessages: ["You do not have the permission to edit this comment."] },
      };
    found.body = field(body, "body");
    return { status: 200, body: found };
  }

  function transition(issue: StubIssue, body: unknown): Answer {
    const id = field(body, "transition", "id");
    const chosen = issue.transitions?.find((offered) => offered.id === id);
    if (chosen === undefined)
      return {
        status: 400,
        body: { errorMessages: [`Transition id '${String(id)}' is not valid for this issue.`] },
      };
    issue.status = chosen.to;
    issue.category = chosen.category ?? "indeterminate";
    return { status: 204 };
  }

  const server = createServer((req, res) => {
    handle(req, res).catch((error: unknown) => {
      res
        .writeHead(500, { "content-type": "application/json" })
        .end(JSON.stringify({ errorMessages: [String(error)] }));
    });
  });
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  return {
    site: `127.0.0.1:${(server.address() as AddressInfo).port}`,
    issues,
    links,
    requests,
    async close() {
      server.closeAllConnections();
      await new Promise((done) => server.close(done));
    },
  };
}

function issueBody(issue: StubIssue): unknown {
  const person = (accountId: string | undefined): unknown =>
    accountId === undefined ? null : { accountId };
  return {
    key: issue.key,
    fields: {
      status: { name: issue.status, statusCategory: { key: issue.category ?? "new" } },
      assignee: person(issue.assignee),
      reporter: person(issue.reporter),
    },
  };
}

function transitionBody(transition: StubTransition): unknown {
  return {
    id: transition.id,
    name: transition.name,
    to: { name: transition.to, statusCategory: { key: transition.category ?? "indeterminate" } },
  };
}

// JSON as parsed, a multipart upload as its files, anything else as text
async function readBody(raw: Buffer, contentType: string | undefined): Promise<unknown> {
  if (raw.length === 0) return undefined;
  if (contentType?.startsWith("multipart/form-data") === true) {
    const form = await new Response(Uint8Array.from(raw), {
      headers: { "content-type": contentType },
    }).formData();
    return form
      .getAll("file")
      .filter((part) => typeof part !== "string")
      .map((file) => ({ name: file.name, size: file.size }));
  }
  const text = raw.toString("utf8");
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return text;
  }
}

function field(value: unknown, ...keys: string[]): unknown {
  let current = value;
  for (const key of keys) {
    if (typeof current !== "object" || current === null) return undefined;
    current = (current as Record<string, unknown>)[key];
  }
  return current;
}

function projectOf(key: string): string {
  return key.replace(/-\d+$/, "");
}

function issueNumber(key: string): number {
  return Number(/-(\d+)$/.exec(key)?.[1] ?? 0);
}
