import { describe, expect, it } from "vite-plus/test";
import { PluginRegistry } from "@bazam/core/plugin";
import { ProjectConfig } from "@bazam/core/project";
import type { MediaRefs } from "@bazam/core/report";
import type { CaseResult, Status } from "@bazam/core/result";
import manifest from "../src/index.ts";
import { jiraTracker, renderJiraComment } from "../src/render.ts";

const CASE_ID = "AUTH-LOGIN-001";

function result(fields: Partial<CaseResult> = {}): CaseResult {
  return {
    runId: "20261107-100000-ab12",
    caseId: CASE_ID,
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

// one screenshot per result carries a collection and the trace has an id too, which must not inline it
const MEDIA: MediaRefs = {
  [`${CASE_ID}/01-dashboard.png`]: { id: "media-dashboard-0001", collection: "contentId-10001" },
  [`${CASE_ID}/01-code-entry.png`]: { id: "media-code-entry-0002" },
  [`${CASE_ID}/02-trace.zip`]: { id: "media-trace-0003", collection: "contentId-10001" },
};

describe("renderJiraComment", () => {
  const statuses = Object.keys(RESULTS) as Status[];

  it.each(statuses)("matches the snapshot for a %s result without media", (status) => {
    expect(renderJiraComment(RESULTS[status])).toMatchSnapshot();
  });

  it.each(statuses)("matches the snapshot for a %s result with media", (status) => {
    expect(renderJiraComment(RESULTS[status], MEDIA)).toMatchSnapshot();
  });

  it.each(statuses)("opens both formats with the result line for a %s result", (status) => {
    const { markdown, html } = renderJiraComment(RESULTS[status]);
    const label = { pass: "Passed", fail: "Failed", blocked: "Blocked", followup: "Needs follow-up" }[status];
    const line = "uat: AUTH-LOGIN-001 Customer signs in with an email code (run 20261107-100000-ab12)";

    expect(markdown.startsWith(`**${label}** on ${line}\n`)).toBe(true);
    expect(html.startsWith(`<p><strong>${label}</strong> on ${line}</p>`)).toBe(true);
  });

  it("escapes markup from every result field in the HTML", () => {
    const { html } = renderJiraComment(
      result({
        status: "blocked",
        title: "Sign in <img src=x onerror=alert(1)>",
        reason: "<script>alert(2)</script>",
        checks: [{ name: "a & b", kind: "api", expected: { note: '"quoted"' }, observed: "<b>bold</b>", ok: false }],
        notes: ["<i>note</i>"],
        followups: [{ item: "<u>item</u>", hint: "it's <s>hint</s>" }],
        attachments: ["01-<x>.txt"],
      }),
    );

    expect(html).not.toMatch(/<(img|script|b|i|u|s|x)[ >]/);
    expect(html).toContain("Sign in &lt;img src=x onerror=alert(1)&gt;");
    expect(html).toContain("<td>a &amp; b</td><td>{&quot;note&quot;:&quot;\\&quot;quoted\\&quot;&quot;}</td>");
    expect(html).toContain("<li>&lt;u&gt;item&lt;/u&gt;: it&#39;s &lt;s&gt;hint&lt;/s&gt;</li>");
  });

  it("inlines only png attachments that have a media reference and lists the rest by file name", () => {
    const { html } = renderJiraComment(
      result({ attachments: ["01-dashboard.png", "02-trace.zip", "03-statement.png"] }),
      MEDIA,
    );

    expect(html.match(/<figure /g)).toHaveLength(1);
    expect(html).toContain(
      'data-id="media-dashboard-0001" data-collection="contentId-10001" data-alt="01-dashboard.png"',
    );
    expect(html).toContain("<figcaption>dashboard</figcaption>");
    expect(html).toContain("<p>Attached files: 02-trace.zip, 03-statement.png</p>");
  });

  it("leaves out data-collection when the media reference has none", () => {
    const { html } = renderJiraComment(result({ attachments: ["01-code-entry.png"] }), MEDIA);

    expect(html).toContain('data-id="media-code-entry-0002" data-alt="01-code-entry.png"');
    expect(html).not.toContain("data-collection");
  });

  it("lists every attachment by file name in the Markdown even when media is given", () => {
    const { markdown } = renderJiraComment(RESULTS.pass, MEDIA);

    expect(markdown).toContain("Attached files: 01-dashboard.png, 02-trace.zip");
  });

  it("omits the evidence section when the result has no checks, notes or attachments", () => {
    const { markdown, html } = renderJiraComment(
      result({ status: "blocked", reason: "the browser could not start", checks: [], attachments: [] }),
    );

    expect(html).not.toContain("<details>");
    expect(markdown).not.toContain("Evidence");
  });

  it("keeps a pipe and a line break inside one Markdown table cell", () => {
    const { markdown } = renderJiraComment(
      result({ checks: [{ name: "totals", kind: "ui", expected: "a | b", observed: "line one\nline two", ok: true }] }),
    );

    expect(markdown).toContain("| totals | a \\| b | line one line two | ok |");
  });

  it("shows link, image and HTML syntax from result values as literal text in the Markdown", () => {
    const { markdown } = renderJiraComment(
      result({
        status: "blocked",
        reason: "see [the help page](https://help.example.test/)",
        checks: [
          {
            name: "message",
            kind: "api",
            expected: "*welcome*",
            observed: {
              "body.message": "[Verify your account](https://login.example.test/) ![x](https://cdn.example.test/p.png)",
            },
            ok: false,
          },
        ],
        notes: ["<b>raw</b> & `code`"],
      }),
    );

    expect(markdown).toContain("Reason: see \\[the help page\\](https://help.example.test/)\n");
    expect(markdown).toContain(
      '| message | \\*welcome\\* | {"body.message":"\\[Verify your account\\](https://login.example.test/) !\\[x\\](https://cdn.example.test/p.png)"} | not ok |',
    );
    expect(markdown).toContain("- \\<b\\>raw\\</b\\> \\& \\`code\\`\n");
  });

  it("keeps a line break in a reason, note or follow-up from starting a new Markdown block", () => {
    const { markdown } = renderJiraComment(
      result({
        reason: "the step failed\n\n# Injected heading",
        notes: ["trace was left out:\n\n<b>raw</b>"],
        followups: [{ item: "layout", hint: "compare it\n\n> with the design" }],
      }),
    );

    expect(markdown.split("\n").filter((line) => /^[#<>]/.test(line))).toEqual(["### Evidence"]);
    expect(markdown).toContain("Reason: the step failed # Injected heading\n");
  });

  it("escapes a block marker at the start of a Markdown list item", () => {
    const { markdown } = renderJiraComment(
      result({ notes: ["# heading", "- nested", "+ nested", "> quote", "1. step", "2) step", "3.5 seconds"] }),
    );

    expect(markdown).toContain(
      [
        "- \\# heading",
        "- \\- nested",
        "- \\+ nested",
        "- \\> quote",
        "- 1\\. step",
        "- 2\\) step",
        "- 3.5 seconds",
      ].join("\n"),
    );
  });
});

describe("tracker-jira plugin", () => {
  it("serves the Jira renderer for jira ticket links once the registry loads it", async () => {
    const registry = await PluginRegistry.load(ProjectConfig.parse({ envs: {} }), import.meta.dirname, [manifest]);

    expect(registry.tracker("jira")).toBe(jiraTracker);
  });
});
