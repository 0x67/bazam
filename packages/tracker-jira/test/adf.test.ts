import { describe, expect, it } from "vite-plus/test";
import type { JsonValue } from "@bazam/core/auth";
import type { CaseResult, Status } from "@bazam/core/result";
import { ATTACHED_FILES_PREFIX, renderJiraAdf, withInlineMedia, type AdfDoc } from "../src/adf.ts";
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
    links: ["jira:DEMO-246"],
    status: "pass",
    checks: [
      {
        name: "dashboard shows the account",
        kind: "ui",
        expected: "visible",
        observed: "visible",
        ok: true,
      },
    ],
    notes: [],
    callouts: [],
    followups: [],
    attachments: ["01-dashboard.png", "02-trace.zip"],
    challenges: [],
    identities: ["customer"],
    seed: 7,
    values: {},
    caseValues: {},
    steps: [],
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
      {
        name: "code entry accepts the code",
        kind: "ui",
        expected: "accepted",
        observed: "accepted",
        ok: true,
      },
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
      {
        name: "dashboard shows the account",
        kind: "ui",
        expected: "visible",
        observed: "visible",
        ok: true,
      },
      {
        name: "welcome email layout",
        kind: "followup",
        expected: "checked by a person",
        observed: "not automated",
        ok: true,
        hint: "open the welcome email and compare it with the design",
      },
    ],
    followups: [
      {
        item: "welcome email layout",
        hint: "open the welcome email and compare it with the design",
      },
    ],
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
    .map((node) =>
      node["type"] === "text" && typeof node["text"] === "string" ? node["text"] : "",
    )
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

    // the HTML fold title is the expand's attribute in ADF, not text
    expect(textOf(adf)).toBe(htmlText(html.replace("<summary>Evidence</summary>", "")));
  });

  it("words the first paragraph from a result line template with the status bold in the middle", () => {
    const doc = renderJiraAdf(
      result({ identities: ["alice", "ops"] }),
      "{env} {date}: {status} (as {identities})",
    );

    expect(doc.content[0]).toEqual({
      type: "paragraph",
      content: [
        { type: "text", text: "uat 2026-11-07: " },
        { type: "text", text: "Passed", marks: [{ type: "strong" }] },
        { type: "text", text: " (as alice, ops)" },
      ],
    });
  });

  it("adds a Level column only when a check has a level, as plain text", () => {
    const levelled = result({
      checks: [
        {
          name: "balance",
          kind: "api",
          expected: "10",
          observed: "10",
          ok: true,
          level: "<b>x</b>",
        },
        { name: "none", kind: "ui", expected: "1", observed: "1", ok: true },
      ],
    });
    const headers = (doc: ReturnType<typeof renderJiraAdf>): string[] =>
      nodes(doc.content)
        .filter((node) => node["type"] === "tableHeader")
        .map((node) => textOf(node));

    expect(headers(renderJiraAdf(result()))).toEqual(["Check", "Expected", "Observed", "Result"]);
    expect(headers(renderJiraAdf(levelled))).toEqual([
      "Check",
      "Expected",
      "Observed",
      "Level",
      "Result",
    ]);
    expect(renderJiraAdf(levelled)).toMatchSnapshot();
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
    expect(
      all.filter((node) => node["type"] === "tableCell").map((cell) => cell["content"]),
    ).toEqual([
      [{ type: "paragraph", content: [{ type: "text", text: "totals" }] }],
      [{ type: "paragraph", content: [] }],
      [{ type: "paragraph", content: [] }],
      [{ type: "paragraph", content: [{ type: "text", text: "not ok" }] }],
    ]);
  });

  it("folds the evidence in one expand titled Evidence with the checks table first", () => {
    const [, expand] = renderJiraAdf(RESULTS.fail).content;
    const types = (expand as { content: JsonValue[] }).content.map(
      (block) => nodes(block)[0]?.["type"],
    );

    expect(expand).toMatchObject({ type: "expand", attrs: { title: "Evidence" } });
    expect(types).toEqual(["table", "paragraph", "bulletList", "paragraph"]);
  });

  it("puts a panel per callout between the reason and the follow-ups and folds the evidence in one expand", () => {
    const doc = renderJiraAdf(
      result({
        status: "fail",
        reason: "one check failed",
        callouts: ["Mind the limit."],
        checks: [
          { name: "balance", kind: "api", expected: "10", observed: "10", ok: true, callout: true },
          { name: "other", kind: "api", expected: "1", observed: "2", ok: false },
        ],
        followups: [{ item: "layout", hint: "look" }],
      }),
    );
    const types = doc.content.map((node) => (node as Record<string, JsonValue>)["type"]);
    const panels = nodes(doc).filter((node) => node["type"] === "panel");

    expect(types).toEqual([
      "paragraph",
      "paragraph",
      "panel",
      "panel",
      "paragraph",
      "bulletList",
      "expand",
    ]);
    expect(panels.map((panel) => panel["attrs"])).toEqual([
      { panelType: "error" },
      { panelType: "success" },
    ]);
    expect(doc.content[6]).toMatchObject({ type: "expand", attrs: { title: "Evidence" } });
    expect(nodes(doc).some((node) => node["type"] === "heading")).toBe(false);
  });

  it("starts the files paragraph with the shared prefix, as the last child of the expand", () => {
    const expand = renderJiraAdf(result()).content.at(-1) as { content: JsonValue[] };

    expect(textOf(expand.content.at(-1) as JsonValue).startsWith(ATTACHED_FILES_PREFIX)).toBe(true);
  });

  it("keeps the panels in the document over 30,000 characters", () => {
    const notes = Array.from({ length: 500 }, (_, index) => `note ${index} `.repeat(10));
    const doc = renderJiraAdf(result({ callouts: ["Mind the limit."], notes }));

    expect(nodes(doc).filter((node) => node["type"] === "panel")).toHaveLength(1);
    expect(nodes(doc).some((node) => node["type"] === "expand")).toBe(false);
  });

  it("cuts a long callout in the over-limit document so the comment can post", () => {
    const observed = Array.from({ length: 1_500 }, (_, index) => `item-${index}-`.padEnd(40, "x"));
    const doc = renderJiraAdf(
      result({
        checks: [{ name: "list", kind: "api", expected: [], observed, ok: false, callout: true }],
        notes: Array.from({ length: 500 }, (_, index) => `note ${index} `.repeat(10)),
      }),
    );

    expect(nodes(doc).filter((node) => node["type"] === "panel")).toHaveLength(1);
    expect(JSON.stringify(doc).length).toBeLessThanOrEqual(30_000);
  });

  it("leaves out the expand when the result has no checks, notes or attachments", () => {
    const doc = renderJiraAdf(
      result({
        status: "blocked",
        reason: "the browser could not start",
        checks: [],
        attachments: [],
      }),
    );

    expect(nodes(doc).some((node) => node["type"] === "expand")).toBe(false);
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
        content: [
          {
            type: "text",
            text: `The evidence is too long for a Jira comment; it is in run ${RUN_ID}`,
          },
        ],
      },
    ]);
  });
});

describe("withInlineMedia", () => {
  const png = { id: "00000000-0000-4000-8000-00000000000a", width: 4, height: 3 };
  const uploaded = new Map([["01-dashboard.png", png]]);

  function expandOf(doc: AdfDoc): { content: Record<string, JsonValue>[] } {
    return doc.content.find((node) => (node as { type: string }).type === "expand") as never;
  }

  it("adds a mediaSingle per uploaded png before the files paragraph and takes the name off the list", () => {
    const doc = withInlineMedia(renderJiraAdf(result()), uploaded);

    const children = expandOf(doc).content;
    expect(children.at(-2)).toEqual({
      type: "mediaSingle",
      attrs: { layout: "align-start" },
      content: [
        {
          type: "media",
          attrs: {
            id: png.id,
            type: "file",
            collection: "",
            alt: "01-dashboard.png",
            width: 4,
            height: 3,
          },
        },
      ],
    });
    expect(textOf(children.at(-1) as JsonValue)).toBe(`${ATTACHED_FILES_PREFIX}02-trace.zip`);
  });

  it("drops the files paragraph when the list empties", () => {
    const doc = withInlineMedia(
      renderJiraAdf(result({ attachments: ["01-dashboard.png"] })),
      uploaded,
    );

    expect(expandOf(doc).content.map((node) => node["type"])).toEqual(["table", "mediaSingle"]);
  });

  it("keeps a png the upload did not name, and a zip, listed", () => {
    const original = renderJiraAdf(result({ attachments: ["02-trace.zip", "03-other.png"] }));

    expect(withInlineMedia(original, uploaded)).toBe(original);
  });

  it("returns a document with no expand or no files paragraph unchanged", () => {
    const bare = renderJiraAdf(result({ checks: [], attachments: [] }));
    const noFiles = renderJiraAdf(result({ attachments: [] }));

    expect(withInlineMedia(bare, uploaded)).toBe(bare);
    expect(withInlineMedia(noFiles, uploaded)).toBe(noFiles);
  });

  it("does not touch a note that starts like the files paragraph", () => {
    const original = renderJiraAdf(
      result({ attachments: [], notes: [`${ATTACHED_FILES_PREFIX}01-dashboard.png`] }),
    );

    expect(withInlineMedia(original, uploaded)).toBe(original);
  });

  it("returns a document that the images would take over 30,000 characters unchanged", () => {
    const build = (pad: number): AdfDoc => ({
      version: 1,
      type: "doc",
      content: [
        {
          type: "expand",
          attrs: { title: "Evidence" },
          content: [
            { type: "paragraph", content: [{ type: "text", text: "x".repeat(pad) }] },
            {
              type: "paragraph",
              content: [{ type: "text", text: `${ATTACHED_FILES_PREFIX}01-dashboard.png` }],
            },
          ],
        },
      ],
    });
    const original = build(30_000 - JSON.stringify(build(0)).length - 50);

    expect(JSON.stringify(original).length).toBeLessThanOrEqual(30_000);
    expect(withInlineMedia(original, uploaded)).toBe(original);
  });
});
