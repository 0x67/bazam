import { describe, expect, it } from "vite-plus/test";
import { BRAND } from "../src/brand.ts";
import { CaseSpec, type Stage } from "../src/case/index.ts";
import { ProjectConfig } from "../src/project.ts";
import {
  buildPostPlans,
  markdownTracker,
  PeopleRegistry,
  type MediaRefs,
  type PostPlanInputs,
  type TrackerRenderer,
} from "../src/report/index.ts";
import type { CaseResult, Status } from "../src/result/index.ts";

const RUN = "20261107-100000-ab12";
const NOW = new Date("2026-11-07T10:05:00Z");

function result(fields: Partial<CaseResult> = {}): CaseResult {
  return {
    runId: RUN,
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
    attachments: ["01-dashboard.png"],
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

function spec(fields: Record<string, unknown> = {}): CaseSpec {
  return CaseSpec.parse({
    id: "AUTH-LOGIN-001",
    title: "Customer signs in with an email code",
    stage: "acceptance",
    risk: "high",
    links: ["jira:TD-246"],
    targets: ["web"],
    ...fields,
  });
}

function inputs(results: CaseResult[], fields: Partial<PostPlanInputs> = {}): PostPlanInputs {
  return {
    runId: RUN,
    env: "uat",
    results,
    specs: new Map(),
    people: new PeopleRegistry({}),
    receipts: { latest: () => undefined },
    trackers: markdownTracker,
    transitions: {},
    now: NOW,
    ...fields,
  };
}

describe("buildPostPlans", () => {
  it("items follow the stage table", () => {
    const posts: Record<Stage, Status[]> = {
      draft: [],
      acceptance: ["pass", "fail", "blocked", "followup"],
      regression: ["fail", "blocked"],
      retired: [],
    };
    const statuses: Status[] = ["pass", "fail", "blocked", "followup"];
    const results = Object.keys(posts).flatMap((stage) =>
      statuses.map((status) => result({ caseId: `${stage}-${status}`, stage: stage as Stage, status })),
    );

    const plan = buildPostPlans(inputs(results));

    const expected = Object.entries(posts).flatMap(([stage, list]) => list.map((status) => `${stage}-${status}`));
    expect(plan.items.map((item) => item.caseId)).toEqual(expected);
  });

  it("marker format is <markerPrefix>:<case-id>:<run-id>, with the rendered comment and attachments under the case folder", () => {
    const plan = buildPostPlans(inputs([result({ attachments: ["01-dashboard.png", "02-trace.zip"] })]));

    expect(plan).toEqual({
      runId: RUN,
      env: "uat",
      createdAt: "2026-11-07T10:05:00.000Z",
      items: [
        {
          marker: `${BRAND.markerPrefix}:AUTH-LOGIN-001:${RUN}`,
          ticket: { tracker: "jira", key: "TD-246" },
          caseId: "AUTH-LOGIN-001",
          status: "pass",
          comment: markdownTracker("jira").render(result({ attachments: ["01-dashboard.png", "02-trace.zip"] })),
          attachments: ["AUTH-LOGIN-001/01-dashboard.png", "AUTH-LOGIN-001/02-trace.zip"],
          mentions: [],
          unresolved: ["transition:pass"],
        },
      ],
    });
  });

  it("a case linked to two tickets gets one item per ticket", () => {
    const plan = buildPostPlans(inputs([result({ links: ["jira:TD-246", "notion:release-notes-42"] })]));

    expect(plan.items.map((item) => item.ticket)).toEqual([
      { tracker: "jira", key: "TD-246" },
      { tracker: "notion", key: "release-notes-42" },
    ]);
  });

  it("case transition wins over project default", () => {
    const transitions = ProjectConfig.shape.trackers.parse({
      jira: { projects: { TD: { transitions: { pass: "Ready for Release", fail: "In Progress" } } } },
    });
    const reopened = spec({ id: "AUTH-LOGIN-002", report: { on: { fail: { transition: "Reopened" } } } });

    const plan = buildPostPlans(
      inputs([result({ status: "fail" }), result({ caseId: "AUTH-LOGIN-002", status: "fail" })], {
        specs: new Map([["AUTH-LOGIN-002", reopened]]),
        transitions,
      }),
    );

    expect(plan.items.map((item) => [item.caseId, item.transition])).toEqual([
      ["AUTH-LOGIN-001", "In Progress"],
      ["AUTH-LOGIN-002", "Reopened"],
    ]);
  });

  it("lists the transition as unresolved only when the ticket's project is missing from the config", () => {
    const transitions = { jira: { projects: { TD: { transitions: { pass: "Ready for Release" } } } } };

    const plan = buildPostPlans(
      inputs([result({ status: "blocked", links: ["jira:TD-246", "jira:OPS-12"] })], { transitions }),
    );

    expect(
      plan.items.map(({ ticket, transition, unresolved }) => ({ key: ticket.key, transition, unresolved })),
    ).toEqual([
      { key: "TD-246", transition: undefined, unresolved: [] },
      { key: "OPS-12", transition: undefined, unresolved: ["transition:blocked"] },
    ]);
  });

  it("treats a tracker or project named like an inherited member, such as constructor, as missing from the config", () => {
    const transitions = { jira: { projects: { TD: { transitions: { fail: "In Progress" } } } } };
    const links = ["jira:constructor-1", "constructor:TD-246", "jira:__proto__-1"];

    const plan = buildPostPlans(inputs([result({ status: "fail", links })], { transitions }));

    expect(plan.items.map(({ transition, unresolved }) => ({ transition, unresolved }))).toEqual(
      links.map(() => ({ transition: undefined, unresolved: ["transition:fail"] })),
    );
  });

  it("stage and links come from the result, so a case promoted after its run still posts its pass", () => {
    const promoted = spec({ stage: "regression", links: ["jira:TD-999"] });

    const plan = buildPostPlans(inputs([result()], { specs: new Map([["AUTH-LOGIN-001", promoted]]) }));

    expect(plan.items.map((item) => item.ticket.key)).toEqual(["TD-246"]);
  });

  it("passes the media references to the ticket's tracker renderer", () => {
    const media: MediaRefs = { "AUTH-LOGIN-001/01-dashboard.png": { id: "media-0001", collection: "contentId-1001" } };
    const seen: (MediaRefs | undefined)[] = [];
    const recording: TrackerRenderer = {
      tracker: "jira",
      render: (_result, refs) => {
        seen.push(refs);
        return { markdown: "body", html: "<p>body</p>" };
      },
    };

    const plan = buildPostPlans(inputs([result()], { trackers: () => recording, media }));

    expect(seen).toEqual([media]);
    expect(plan.items[0]?.comment).toEqual({ markdown: "body", html: "<p>body</p>" });
  });
});

describe("markdownTracker", () => {
  it("opens with the result line, then follow-ups, then checks, notes and attachments by file name", () => {
    const followup = result({
      status: "followup",
      checks: [
        { name: "dashboard shows the account", kind: "ui", expected: "visible", observed: "visible", ok: true },
        { name: "balance matches", kind: "api", expected: { amount: 10 }, observed: "10 | 10", ok: true },
        {
          name: "email reads well",
          kind: "followup",
          expected: "checked by a person",
          observed: "not automated",
          ok: true,
        },
      ],
      followups: [{ item: "email reads well", hint: "open the code email in the inbox" }],
      notes: ["Signed in on the second code."],
    });

    expect(markdownTracker("notion").render(followup).markdown).toBe(
      [
        `**Needs follow-up** on uat: AUTH-LOGIN-001 Customer signs in with an email code (run ${RUN})`,
        "",
        "Follow-up for a person:",
        "",
        "- email reads well: open the code email in the inbox",
        "",
        "### Evidence",
        "",
        "| Check | Expected | Observed | Result |",
        "| --- | --- | --- | --- |",
        "| dashboard shows the account | visible | visible | ok |",
        '| balance matches | {"amount":10} | 10 \\| 10 | ok |',
        "| email reads well | checked by a person | not automated | ok |",
        "",
        "Notes: Signed in on the second code.",
        "",
        "Attachments: 01-dashboard.png",
        "",
      ].join("\n"),
    );
  });

  it("puts the reason under the result line when the case did not finish", () => {
    const blocked = result({ status: "blocked", reason: "no fallback resolver for otp", checks: [], attachments: [] });

    expect(markdownTracker("notion").render(blocked).markdown.split("\n").slice(0, 3)).toEqual([
      `**Blocked** on uat: AUTH-LOGIN-001 Customer signs in with an email code (run ${RUN})`,
      "",
      "Reason: no fallback resolver for otp",
    ]);
  });

  it("shows link, image and HTML syntax from result values as literal text", () => {
    const blocked = result({
      status: "blocked",
      title: "Customer opens [the offer](https://offer.example.test/)",
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
      attachments: ["01-<img src=x>.png"],
    });

    const { markdown } = markdownTracker("notion").render(blocked);

    expect(markdown).toContain(
      `AUTH-LOGIN-001 Customer opens \\[the offer\\](https://offer.example.test/) (run ${RUN})\n`,
    );
    expect(markdown).toContain("Reason: see \\[the help page\\](https://help.example.test/)\n");
    expect(markdown).toContain(
      '| message | \\*welcome\\* | {"body.message":"\\[Verify your account\\](https://login.example.test/) !\\[x\\](https://cdn.example.test/p.png)"} | not ok |',
    );
    expect(markdown).toContain("Notes: \\<b\\>raw\\</b\\> \\& \\`code\\`\n");
    expect(markdown).toContain("Attachments: 01-\\<img src=x\\>.png\n");
  });

  it("keeps a line break in a reason, note or follow-up from starting a new Markdown block", () => {
    const blocked = result({
      status: "blocked",
      reason: "the step failed\n\n# Injected heading",
      notes: ["trace was left out:\n\n<b>raw</b>"],
      followups: [{ item: "layout", hint: "compare it\n\n> with the design" }],
    });

    const { markdown } = markdownTracker("notion").render(blocked);

    expect(markdown.split("\n").filter((line) => /^[#<>]/.test(line))).toEqual(["### Evidence"]);
    expect(markdown).toContain("Reason: the step failed # Injected heading\n");
    expect(markdown).toContain("- layout: compare it \\> with the design\n");
  });

  it("escapes a block marker at the start of a follow-up list item", () => {
    const items = ["# heading", "- nested", "+ nested", "> quote", "1. step", "2) step", "3.5 seconds"];
    const followup = result({ status: "followup", followups: items.map((item) => ({ item, hint: "check it" })) });

    const { markdown } = markdownTracker("notion").render(followup);

    expect(markdown).toContain(
      [
        "- \\# heading: check it",
        "- \\- nested: check it",
        "- \\+ nested: check it",
        "- \\> quote: check it",
        "- 1\\. step: check it",
        "- 2\\) step: check it",
        "- 3.5 seconds: check it",
      ].join("\n"),
    );
  });
});
