import { describe, expect, it } from "vite-plus/test";
import type { JsonValue } from "@bazam/core/auth";
import type { CaseResult, Status } from "@bazam/core/result";
import { renderJiraAdf } from "../src/adf.ts";
import { renderJiraComment } from "../src/render.ts";

const RUN_ID = "20261107-100000-ab12";

function result(fields: Partial<CaseResult> = {}): CaseResult {
  return {
    runId: RUN_ID,
    caseId: "AUTH-LOGIN-001",
    title: "Customer signs in with an email code",
    stage: "acceptance",
    env: "uat",
    target: "web",
    links: ["jira:TD-246"],
    status: "pass",
    checks: [{ name: "dashboard shows the account", kind: "ui", expected: "visible", observed: "visible", ok: true }],
    notes: [],
    followups: [],
    attachments: ["01-dashboard.png", "02-trace.zip"],
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

const RESULTS: Record<Status, CaseResult> = {
  pass: result(),
  fail: result({
    status: "fail",
    checks: [
      { name: "code entry accepts the code", kind: "ui", expected: "accepted", observed: "accepted", ok: true },
      {
        name: "session endpoint returns the customer",
        kind: "api",
        expected: { status: 200 },
        observed: { status: 401 },
        ok: false,
      },
    ],
    notes: ["The code arrived 40 seconds after the request."],
    attachments: ["01-code-entry.png", "02-trace.zip", "03-session.json"],
  }),
  blocked: result({
    status: "blocked",
    reason: "the email code did not arrive within 60 seconds",
    checks: [],
    notes: ["The mailbox for customer@example.test stayed empty."],
    attachments: ["01-code-entry.png"],
  }),
  followup: result({
    status: "followup",
    checks: [
      { name: "dashboard shows the account", kind: "ui", expected: "visible", observed: "visible", ok: true },
      {
        name: "welcome email layout",
        kind: "followup",
        expected: "checked by a person",
        observed: "not automated",
        ok: true,
        hint: "open the welcome email and compare it with the design",
      },
    ],
    followups: [{ item: "welcome email layout", hint: "open the welcome email and compare it with the design" }],
    attachments: ["01-dashboard.png"],
  }),
};

function nodes(value: JsonValue): Record<string, JsonValue>[] {
  if (typeof value !== "object" || value === null) return [];
  if (Array.isArray(value)) return value.flatMap(nodes);
  const content = value["content"];
  return [value, ...(content === undefined ? [] : nodes(content))];
}

function textOf(value: JsonValue): string {
  return nodes(value)
    .map((node) => (node["type"] === "text" && typeof node["text"] === "string" ? node["text"] : ""))
    .join("");
}

function htmlText(html: string): string {
  return html
    .replace(/<[^>]*>/g, "")
    .replaceAll("&quot;", '"')
    .replaceAll("&#39;", "'")
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&amp;", "&");
}

describe("renderJiraAdf", () => {
  const statuses = Object.keys(RESULTS) as Status[];

  it.each(statuses)("matches the snapshot for a %s result", (status) => {
    expect(renderJiraAdf(RESULTS[status])).toMatchSnapshot();
  });

  it.each(statuses)("holds the text of the HTML comment in its order for a %s result", (status) => {
    const { html, adf } = renderJiraComment(RESULTS[status]);

    expect(textOf(adf)).toBe(htmlText(html));
  });

  it("renders an empty value as no text node and an empty cell as an empty paragraph", () => {
    const doc = renderJiraAdf(
      result({
        status: "fail",
        reason: "",
        checks: [{ name: "totals", kind: "api", expected: "", observed: undefined, ok: false }],
        notes: [""],
        followups: [{ item: "", hint: "" }],
        attachments: [],
      }),
    );
    const all = nodes(doc.content);

    expect(all.filter((node) => node["type"] === "text" && node["text"] === "")).toEqual([]);
    expect(all.filter((node) => node["type"] === "tableCell").map((cell) => cell["content"])).toEqual([
      [{ type: "paragraph", content: [{ type: "text", text: "totals" }] }],
      [{ type: "paragraph", content: [] }],
      [{ type: "paragraph", content: [] }],
      [{ type: "paragraph", content: [{ type: "text", text: "not ok" }] }],
    ]);
  });

  it("puts the evidence under a level 3 heading before the checks table", () => {
    const types = renderJiraAdf(RESULTS.fail).content.map((block) => nodes(block)[0]?.["type"]);

    expect(types).toEqual(["paragraph", "heading", "table", "paragraph", "bulletList", "paragraph"]);
    expect(renderJiraAdf(RESULTS.fail).content[1]).toEqual({
      type: "heading",
      attrs: { level: 3 },
      content: [{ type: "text", text: "Evidence" }],
    });
  });

  it("leaves out the evidence heading when the result has no checks, notes or attachments", () => {
    const doc = renderJiraAdf(
      result({ status: "blocked", reason: "the browser could not start", checks: [], attachments: [] }),
    );

    expect(textOf(doc.content)).not.toContain("Evidence");
    expect(doc.content).toHaveLength(2);
  });

  it("keeps the result line, reason and follow-ups and names the run in place of evidence over 30,000 characters", () => {
    const head = {
      status: "fail" as const,
      reason: "the session endpoint answered 401",
      followups: [{ item: "session lifetime", hint: "check it with the platform team" }],
    };
    const notes = Array.from({ length: 500 }, (_, index) => `note ${index} `.repeat(10));
    const doc = renderJiraAdf(result({ ...head, notes }));

    expect(notes.join("").length).toBeGreaterThan(30_000);
    expect(JSON.stringify(doc).length).toBeLessThanOrEqual(30_000);
    expect(doc.content).toEqual([
      ...renderJiraAdf(result({ ...head, checks: [], attachments: [] })).content,
      {
        type: "paragraph",
        content: [{ type: "text", text: `The evidence is too long for a Jira comment; it is in run ${RUN_ID}` }],
      },
    ]);
  });
});
