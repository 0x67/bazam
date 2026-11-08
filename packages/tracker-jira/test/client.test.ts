import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { PluginRegistry } from "@bazam/core/plugin";
import { ProjectConfig, TrackerConfig } from "@bazam/core/project";
import { defaultRedactionRules, Redactor } from "@bazam/core/redact";
import {
  TrackerRequestFailed,
  type AttachmentFile,
  type BugDraft,
  type TrackerClientContext,
  type TrackerConnection,
} from "@bazam/core/report";
import type { CaseResult } from "@bazam/core/result";
import { jiraClient } from "../src/client.ts";
import manifest from "../src/index.ts";
import { jiraTracker } from "../src/render.ts";
import { startJiraStub, type JiraStub, type StubIssue } from "./support/jira-stub.ts";

const EMAIL = "qa@example.test";
const TOKEN = "fake-token-4821";
const WRONG_TOKEN = "fake-token-7310";
const RUN_ID = "20261107-100000-ab12";
const LABEL = "regression-AUTH-LOGIN-001";

function result(fields: Partial<CaseResult> = {}): CaseResult {
  return {
    runId: RUN_ID,
    caseId: "AUTH-LOGIN-001",
    title: "Customer signs in with an email code",
    stage: "regression",
    env: "uat",
    target: "web",
    links: ["jira:DEMO-12"],
    status: "fail",
    checks: [{ name: "session endpoint returns the customer", kind: "api", expected: 200, observed: 401, ok: false }],
    notes: [],
    followups: [],
    attachments: ["01-code-entry.png"],
    challenges: [],
    identities: ["customer"],
    seed: 7,
    values: {},
    startedAt: "2026-11-07T10:00:00.000Z",
    finishedAt: "2026-11-07T10:01:00.000Z",
    durationMs: 60_000,
    ...fields,
  };
}

function seed(): StubIssue[] {
  return [
    {
      key: "DEMO-12",
      status: "In Review",
      category: "indeterminate",
      assignee: "acct-assignee-01",
      reporter: "acct-reporter-02",
      transitions: [
        { id: "31", name: "Approve", to: "Ready for Release" },
        { id: "41", name: "Reopen", to: "In Progress" },
      ],
    },
    { key: "DEMO-13", status: "Done", category: "done" },
  ];
}

describe("jiraClient", () => {
  let stub: JiraStub;
  let logs: string[];
  let folder: string;

  beforeEach(async () => {
    stub = await startJiraStub({ email: EMAIL, token: TOKEN, issues: seed() });
    logs = [];
    folder = await mkdtemp(join(tmpdir(), "jira-client-"));
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await stub.close();
    await rm(folder, { recursive: true, force: true });
  });

  function context(config: Record<string, unknown> = {}, token = TOKEN): TrackerClientContext {
    const redactor = new Redactor(defaultRedactionRules());
    const secrets: Record<string, string> = { JIRA_EMAIL: EMAIL, JIRA_API_TOKEN: token };
    return {
      config: TrackerConfig.parse({
        site: stub.site,
        secrets: { email: "JIRA_EMAIL", token: "JIRA_API_TOKEN" },
        projects: { DEMO: { bugs: { issueType: "Bug", labels: ["regression"] } } },
        ...config,
      }),
      secret: (name) => {
        const value = secrets[name] ?? "";
        redactor.register(value);
        return Promise.resolve(value);
      },
      redactor,
      signal: new AbortController().signal,
      log: (line) => logs.push(line),
    };
  }

  function connect(config: Record<string, unknown> = {}): Promise<TrackerConnection> {
    return jiraClient.connect(context(config));
  }

  async function files(count: number): Promise<AttachmentFile[]> {
    return Promise.all(
      Array.from({ length: count }, async (_, index) => {
        const name = `${String(index + 1).padStart(2, "0")}-evidence.txt`;
        await writeFile(join(folder, name), `evidence ${index + 1}\n`);
        return { name, path: join(folder, name) };
      }),
    );
  }

  function sent(method?: string): string[] {
    return stub.requests
      .filter((request) => method === undefined || request.method === method)
      .map((request) => `${request.method} ${request.path}`);
  }

  it("reads the status, its category and the account ids of a ticket", async () => {
    const connection = await connect();

    await expect(connection.ticket("DEMO-12")).resolves.toEqual({
      key: "DEMO-12",
      status: "In Review",
      done: false,
      assignee: "acct-assignee-01",
      reporter: "acct-reporter-02",
    });
    await expect(connection.ticket("DEMO-13")).resolves.toEqual({ key: "DEMO-13", status: "Done", done: true });
    expect(sent()).toEqual(["GET /rest/api/3/issue/DEMO-12", "GET /rest/api/3/issue/DEMO-13"]);
    expect(stub.requests[0]?.query).toEqual({ fields: "status,assignee,reporter" });
  });

  it("uploads at most ten attachments per request", async () => {
    const connection = await connect();
    const uploads = await files(12);

    await connection.attach("DEMO-12", uploads);

    expect(stub.issues.get("DEMO-12")?.attachments?.map((file) => file.name)).toEqual(uploads.map((file) => file.name));
    expect(stub.requests.map((request) => (Array.isArray(request.body) ? request.body.length : 0))).toEqual([10, 2]);
  });

  it("posts the ADF comment with a last paragraph of mentions and returns its browse URL", async () => {
    const connection = await connect();
    const comment = jiraTracker.render(result());

    const posted = await connection.postComment("DEMO-12", comment, [
      { role: "assignee", accountId: "acct-assignee-01" },
      { role: "qa", accountId: "acct-qa-03" },
    ]);

    const [stored] = stub.issues.get("DEMO-12")?.comments ?? [];
    expect(posted.url).toBe(`http://${stub.site}/browse/DEMO-12?focusedCommentId=${stored?.id}`);
    const adf = comment.adf as { content: unknown[] };
    expect(stored?.body).toEqual({
      ...adf,
      content: [
        ...adf.content,
        {
          type: "paragraph",
          content: [
            { type: "mention", attrs: { id: "acct-assignee-01", text: "@assignee" } },
            { type: "text", text: " " },
            { type: "mention", attrs: { id: "acct-qa-03", text: "@qa" } },
          ],
        },
      ],
    });
  });

  it("edits the comment that a browse URL or a REST comment URL names", async () => {
    const connection = await connect();
    const { url } = await connection.postComment("DEMO-12", jiraTracker.render(result()), []);
    const id = new URL(url).searchParams.get("focusedCommentId") ?? "";
    const passed = jiraTracker.render(result({ status: "pass", checks: [], attachments: [] }));

    await expect(connection.editComment("DEMO-12", url, passed, [])).resolves.toEqual({ url });
    await expect(
      connection.editComment("DEMO-12", `http://${stub.site}/rest/api/3/issue/DEMO-12/comment/${id}`, passed, []),
    ).resolves.toEqual({ url });

    expect(sent("PUT")).toEqual([
      `PUT /rest/api/3/issue/DEMO-12/comment/${id}`,
      `PUT /rest/api/3/issue/DEMO-12/comment/${id}`,
    ]);
    expect(stub.issues.get("DEMO-12")?.comments).toEqual([{ id, body: passed.adf }]);
  });

  it.each([
    ["a browse URL without a comment", "https://example.atlassian.net/browse/DEMO-12"],
    ["text that is not a URL", "posted by an agent"],
    [
      "a traversal in focusedCommentId",
      "https://example.atlassian.net/browse/DEMO-12?focusedCommentId=../../13/comment/1",
    ],
    [
      "an encoded traversal in a REST URL",
      "https://example.atlassian.net/rest/api/3/issue/DEMO-12/comment/1%2F..%2F..%2FDEMO-13",
    ],
  ])("returns undefined and sends no PUT for %s", async (_, url) => {
    const connection = await connect();

    await expect(connection.editComment("DEMO-12", url, jiraTracker.render(result()), [])).resolves.toBeUndefined();
    expect(stub.requests).toEqual([]);
  });

  it("moves a ticket by transition name or by target status, ignoring case", async () => {
    const connection = await connect();

    await connection.transition("DEMO-12", "approve");
    await connection.transition("DEMO-12", "IN PROGRESS");

    expect(stub.requests.filter((request) => request.method === "POST").map((request) => request.body)).toEqual([
      { transition: { id: "31" } },
      { transition: { id: "41" } },
    ]);
    expect(stub.issues.get("DEMO-12")?.status).toBe("In Progress");
  });

  it("names the offered transitions when none matches and moves nothing", async () => {
    const connection = await connect();

    await expect(connection.transition("DEMO-12", "Done")).rejects.toThrow(
      "transition Done is not available on DEMO-12; it offers Approve, Reopen",
    );
    expect(sent("POST")).toEqual([]);
  });

  it("finds the newest open issue with the label in the project", async () => {
    stub.issues.set("DEMO-20", { key: "DEMO-20", status: "Open", labels: [LABEL] });
    stub.issues.set("DEMO-21", { key: "DEMO-21", status: "In Progress", category: "indeterminate", labels: [LABEL] });
    stub.issues.set("DEMO-22", { key: "DEMO-22", status: "Closed", category: "done", labels: [LABEL] });
    stub.issues.set("OTHER-5", { key: "OTHER-5", status: "Open", labels: [LABEL] });
    const connection = await connect();

    await expect(connection.findOpenBug("DEMO", LABEL)).resolves.toBe("DEMO-21");
    await expect(connection.findOpenBug("DEMO", "regression-AUTH-LOGIN-002")).resolves.toBeUndefined();
    expect(stub.requests[0]?.body).toEqual({
      jql: `project = "DEMO" AND labels = "${LABEL}" AND statusCategory != Done ORDER BY created DESC`,
      fields: ["created"],
      maxResults: 1,
    });
  });

  it("escapes a quote and a backslash in JQL values", async () => {
    const label = 'odd"label\\';
    stub.issues.set("DEMO-30", { key: "DEMO-30", status: "Open", labels: [label] });
    const connection = await connect();

    await expect(connection.findOpenBug("DEMO", label)).resolves.toBe("DEMO-30");
    expect(stub.requests[0]?.body).toMatchObject({
      jql: 'project = "DEMO" AND labels = "odd\\"label\\\\" AND statusCategory != Done ORDER BY created DESC',
    });
  });

  it("creates a bug, then attaches its files, then links it to each ticket, one request at a time", async () => {
    const send = globalThis.fetch;
    let inFlight = 0;
    let maxInFlight = 0;
    vi.spyOn(globalThis, "fetch").mockImplementation(async (...args) => {
      maxInFlight = Math.max(maxInFlight, ++inFlight);
      try {
        return await send(...args);
      } finally {
        inFlight -= 1;
      }
    });
    const connection = await connect();
    const description = jiraTracker.render(result());
    const draft: BugDraft = {
      project: "DEMO",
      issueType: "Bug",
      summary: "[AUTH-LOGIN-001] Customer signs in with an email code fails in uat",
      labels: ["regression", LABEL],
      description,
      attachments: await files(1),
      relatesTo: ["DEMO-12", "DEMO-13"],
    };

    await expect(connection.createBug(draft)).resolves.toEqual({
      key: "DEMO-14",
      url: `http://${stub.site}/browse/DEMO-14`,
    });

    expect(sent()).toEqual([
      "POST /rest/api/3/issue",
      "POST /rest/api/3/issue/DEMO-14/attachments",
      "GET /rest/api/3/issueLinkType",
      "POST /rest/api/3/issueLink",
      "POST /rest/api/3/issueLink",
    ]);
    expect(stub.issues.get("DEMO-14")).toMatchObject({
      issueType: "Bug",
      summary: draft.summary,
      labels: draft.labels,
      description: description.adf,
      attachments: [{ name: "01-evidence.txt" }],
    });
    expect(stub.links).toEqual([
      { type: "Relates", inward: "DEMO-14", outward: "DEMO-12" },
      { type: "Relates", inward: "DEMO-14", outward: "DEMO-13" },
    ]);
    expect(maxInFlight).toBe(1);

    await connection.createBug({ ...draft, attachments: [], relatesTo: ["DEMO-12"] });
    expect(sent("GET")).toEqual(["GET /rest/api/3/issueLinkType"]);
  });

  it("skips the links and logs why when no issue link type has the configured name", async () => {
    const connection = await connect({
      projects: { DEMO: { bugs: { issueType: "Bug", linkType: "Caused by" } } },
    });

    const bug = await connection.createBug({
      project: "DEMO",
      issueType: "Bug",
      summary: "[AUTH-LOGIN-001] fails in uat",
      labels: [],
      description: jiraTracker.render(result()),
      attachments: [],
      relatesTo: ["DEMO-12"],
    });

    expect(bug.key).toBe("DEMO-14");
    expect(sent()).not.toContain("POST /rest/api/3/issueLink");
    expect(logs).toContain("no issue link type named Caused by");
  });

  it("sends the paragraph that names the run when the evidence is over 30,000 characters", async () => {
    const connection = await connect();
    const notes = Array.from({ length: 500 }, (_, index) => `note ${index} `.repeat(10));

    await connection.postComment("DEMO-12", jiraTracker.render(result({ notes })), [
      { role: "assignee", accountId: "acct-assignee-01" },
    ]);

    const body = JSON.stringify(stub.issues.get("DEMO-12")?.comments?.[0]?.body);
    expect(body).toContain(`The evidence is too long for a Jira comment; it is in run ${RUN_ID}`);
    expect(body.length).toBeLessThan(32_767);
  });

  it("sends REST calls to api under its base path while browse links use the site", async () => {
    const connection = await connect({ site: "example.atlassian.net", api: `http://${stub.site}/ex/jira/cloud-0001` });

    await connection.ticket("DEMO-12");
    const { url } = await connection.postComment("DEMO-12", jiraTracker.render(result()), []);

    expect(sent()).toEqual([
      "GET /ex/jira/cloud-0001/rest/api/3/issue/DEMO-12",
      "POST /ex/jira/cloud-0001/rest/api/3/issue/DEMO-12/comment",
    ]);
    expect(url).toMatch(/^https:\/\/example\.atlassian\.net\/browse\/DEMO-12\?focusedCommentId=\d+$/);
  });

  it("fails a wrong token with a TrackerRequestFailed that never shows the token", async () => {
    const ctx = context({}, WRONG_TOKEN);
    const connection = await jiraClient.connect(ctx);

    const error: unknown = await connection.ticket("DEMO-12").catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(TrackerRequestFailed);
    expect(error).toMatchObject({ status: 401 });
    const message = (error as Error).message;
    expect(message).toMatch(/^GET \/rest\/api\/3\/issue\/DEMO-12 answered 401/);
    const basic = Buffer.from(`${EMAIL}:${WRONG_TOKEN}`).toString("base64");
    for (const text of [message, ...logs]) {
      expect(text).not.toContain(WRONG_TOKEN);
      expect(text).not.toContain(basic);
    }
    expect(ctx.redactor.text(basic)).toBe("[redacted]");
  });

  it.each([
    ["an api outside api.atlassian.com", { api: "https://jira.example.test/ex/jira/cloud-0001" }, "trackers.jira.api"],
    ["a project key with a quote", { projects: { 'DEMO" OR project = "OPS': {} } }, "not a Jira project key"],
    ["a missing site", { site: undefined }, "trackers.jira.site is not set"],
    ["a missing token name", { secrets: { email: "JIRA_EMAIL" } }, "trackers.jira.secrets.token is not set"],
  ])("refuses %s at connect", async (_, config, message) => {
    await expect(connect(config)).rejects.toThrow(message);
    expect(stub.requests).toEqual([]);
  });

  it("accepts a scoped token's api", async () => {
    await expect(connect({ api: "https://api.atlassian.com/ex/jira/cloud-0001" })).resolves.toBeDefined();
  });

  it("refuses a key that is not a Jira issue key before any request", async () => {
    const connection = await connect();

    await expect(connection.ticket("DEMO-12/../../../myself")).rejects.toThrow(
      "DEMO-12/../../../myself is not a Jira issue key",
    );
    await expect(connection.postComment("demo-12", jiraTracker.render(result()), [])).rejects.toThrow(
      "demo-12 is not a Jira issue key",
    );
    expect(stub.requests).toEqual([]);
  });

  it("is the tracker client the plugin serves for jira", async () => {
    const registry = await PluginRegistry.load(ProjectConfig.parse({ envs: {} }), import.meta.dirname, [manifest]);

    expect(registry.trackerClient("jira")).toBe(jiraClient);
  });
});
