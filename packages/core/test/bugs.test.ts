import { join } from "node:path";
import { describe, expect, it } from "vite-plus/test";
import { BRAND } from "../src/brand.ts";
import type { Stage } from "../src/case/index.ts";
import { ProjectConfig } from "../src/project.ts";
import { defaultRedactionRules, Redactor } from "../src/redact/index.ts";
import {
  applyBugs,
  planBugs,
  type BugInputs,
  type BugIntent,
  type TrackerConnection,
  type TrackerRenderer,
} from "../src/report/index.ts";
import type { CaseResult, Status } from "../src/result/index.ts";
import { FakeTrackerConnection } from "./support/fake-tracker.ts";

const RUN = "20261108-100000-ab12";
const RUN_DIR = join("/work", "runs", RUN);
const LABEL = `${BRAND.markerPrefix}-CHECKOUT-CART-001`;
const REASON = "the total is 90.00, expected 81.00";

const CONFIG = ProjectConfig.parse({
  envs: {},
  trackers: {
    jira: {
      site: "tracker.example.test",
      projects: {
        SHOP: {},
        DEMO: { bugs: { issueType: "Bug", labels: ["regression"], onPass: "Done" } },
        BUGS: { bugs: { issueType: "Defect" } },
      },
    },
    linear: { projects: { ENG: { bugs: { issueType: "Bug" } } } },
  },
});

function result(fields: Partial<CaseResult> = {}): CaseResult {
  return {
    runId: RUN,
    caseId: "CHECKOUT-CART-001",
    title: "Cart total includes the discount",
    stage: "regression",
    env: "uat",
    target: "web",
    links: ["jira:DEMO-12"],
    status: "fail",
    checks: [],
    notes: [],
    callouts: [],
    followups: [],
    attachments: ["01-cart.png"],
    challenges: [],
    identities: ["customer"],
    seed: 7,
    values: {},
    caseValues: {},
    steps: [],
    startedAt: "2026-11-08T10:00:00.000Z",
    finishedAt: "2026-11-08T10:01:00.000Z",
    durationMs: 60_000,
    ...fields,
  };
}

// every format of the comment carries the reason, so masking can be seen in each
function renderer(tracker: string): TrackerRenderer {
  return {
    tracker,
    render: (result) => ({
      markdown: `${tracker} ${result.status}: ${result.reason ?? ""}`,
      adf: { type: "text", text: result.reason ?? "" },
    }),
  };
}

function inputs(
  results: CaseResult[],
  redactor = new Redactor(defaultRedactionRules()),
): BugInputs {
  return { results, config: CONFIG, renderer, runDir: RUN_DIR, redactor };
}

describe("planBugs", () => {
  it("files a failing regression case in the first linked project that sets bugs, relating its listed tickets", () => {
    const failed = result({
      reason: REASON,
      links: ["jira:SHOP-3", "jira:DEMO-12", "jira:OPS-9", "linear:ENG-4", "jira:BUGS-1"],
    });
    const comment = { markdown: `jira fail: ${REASON}`, adf: { type: "text", text: REASON } };

    expect(planBugs(inputs([failed]))).toEqual([
      {
        kind: "file",
        caseId: "CHECKOUT-CART-001",
        tracker: "jira",
        project: "DEMO",
        label: LABEL,
        draft: {
          project: "DEMO",
          issueType: "Bug",
          summary: "[CHECKOUT-CART-001] Cart total includes the discount fails in uat",
          labels: ["regression", LABEL],
          description: comment,
          attachments: [
            { name: "01-cart.png", path: join(RUN_DIR, "CHECKOUT-CART-001", "01-cart.png") },
          ],
          relatesTo: ["SHOP-3", "DEMO-12", "BUGS-1"],
        },
        comment,
      },
    ]);
  });

  it("plans a recovery for a passing regression case, with the project's onPass transition when it sets one", () => {
    const intents = planBugs(
      inputs([
        result({ status: "pass" }),
        result({ caseId: "CHECKOUT-CART-002", status: "pass", links: ["linear:ENG-4"] }),
      ]),
    );

    expect(intents).toEqual([
      {
        kind: "recover",
        caseId: "CHECKOUT-CART-001",
        tracker: "jira",
        project: "DEMO",
        label: LABEL,
        comment: { markdown: "jira pass: ", adf: { type: "text", text: "" } },
        transition: "Done",
      },
      {
        kind: "recover",
        caseId: "CHECKOUT-CART-002",
        tracker: "linear",
        project: "ENG",
        label: `${BRAND.markerPrefix}-CHECKOUT-CART-002`,
        comment: { markdown: "linear pass: ", adf: { type: "text", text: "" } },
      },
    ]);
  });

  it("plans nothing for blocked or follow-up results, other stages, or a case with no bug project", () => {
    const quiet: [Stage, Status, string[]][] = [
      ["regression", "blocked", ["jira:DEMO-12"]],
      ["regression", "followup", ["jira:DEMO-12"]],
      ["acceptance", "fail", ["jira:DEMO-12"]],
      ["regression", "fail", ["jira:SHOP-3", "jira:OPS-9"]],
      ["regression", "fail", []],
    ];

    expect(
      planBugs(inputs(quiet.map(([stage, status, links]) => result({ stage, status, links })))),
    ).toEqual([]);
  });

  it("leaves out an attachment whose name leads outside the run folder", () => {
    const [intent] = planBugs(
      inputs([result({ attachments: ["01-cart.png", "../../outside.txt"] })]),
    );

    expect(intent).toMatchObject({
      draft: {
        attachments: [
          { name: "01-cart.png", path: join(RUN_DIR, "CHECKOUT-CART-001", "01-cart.png") },
        ],
      },
    });
  });

  it("leaves a withheld attachment out of the draft and the comment", () => {
    const naming: TrackerRenderer = {
      tracker: "jira",
      render: (result) => ({
        markdown: result.attachments.join(","),
        adf: { type: "text", text: "" },
      }),
    };
    const withheld = new Map([["CHECKOUT-CART-001/02-trace.zip", ["fixture alice.phone"]]]);
    const [intent] = planBugs({
      ...inputs([result({ attachments: ["01-cart.png", "02-trace.zip"] })]),
      renderer: () => naming,
      withheld,
    });

    expect(intent).toMatchObject({
      comment: { markdown: "01-cart.png" },
      draft: { attachments: [{ name: "01-cart.png" }] },
    });
    expect(JSON.stringify(intent)).not.toContain("02-trace.zip");
  });

  it("masks the draft and the comment with the project's patterns", () => {
    const redactor = new Redactor(defaultRedactionRules());
    redactor.configure({ patterns: ["ORDER-[0-9]{4}"], screenshotSelectors: [] });
    const failed = result({
      title: "ORDER-7731 checks out",
      reason: "ORDER-7731 was charged twice",
    });

    const [intent] = planBugs(inputs([failed], redactor));

    expect(JSON.stringify(intent)).not.toContain("ORDER-7731");
    expect(intent).toMatchObject({
      draft: {
        summary: "[CHECKOUT-CART-001] [redacted] checks out fails in uat",
        description: {
          markdown: "jira fail: [redacted] was charged twice",
          adf: { text: "[redacted] was charged twice" },
        },
      },
      comment: { markdown: "jira fail: [redacted] was charged twice" },
    });
  });
});

describe("applyBugs", () => {
  const connected = (connection: TrackerConnection) => async () => connection;

  it("files one bug for a failing case, then comments on it while it stays open", async () => {
    const connection = new FakeTrackerConnection();
    const intents = planBugs(inputs([result()]));

    const first = await applyBugs(intents, connected(connection));
    const second = await applyBugs(intents, connected(connection));

    expect(first).toEqual([
      {
        caseId: "CHECKOUT-CART-001",
        ok: true,
        action: "filed DEMO-901",
        key: "DEMO-901",
        url: "https://tracker.example.test/browse/DEMO-901",
      },
    ]);
    expect(second).toEqual([
      {
        caseId: "CHECKOUT-CART-001",
        ok: true,
        action: "commented on DEMO-901",
        key: "DEMO-901",
        url: "https://tracker.example.test/browse/DEMO-901?focusedCommentId=10001",
      },
    ]);
    expect(connection.calls).toEqual([
      { method: "findOpenBug", project: "DEMO", label: LABEL },
      { method: "createBug", draft: (intents[0] as Extract<BugIntent, { kind: "file" }>).draft },
      { method: "findOpenBug", project: "DEMO", label: LABEL },
      { method: "postComment", key: "DEMO-901", comment: intents[0]!.comment, mentions: [] },
    ]);
  });

  it("comments on a passing case's open bug and moves it, and does nothing when no bug is open", async () => {
    const connection = new FakeTrackerConnection([
      { key: "DEMO-77", status: "Open", labels: ["regression", LABEL] },
    ]);
    const intents = planBugs(
      inputs([result({ status: "pass" }), result({ caseId: "CHECKOUT-CART-002", status: "pass" })]),
    );

    const outcomes = await applyBugs(intents, connected(connection));

    expect(outcomes).toEqual([
      {
        caseId: "CHECKOUT-CART-001",
        ok: true,
        action: "commented on DEMO-77 and moved it to Done",
        key: "DEMO-77",
        url: "https://tracker.example.test/browse/DEMO-77?focusedCommentId=10001",
      },
      { caseId: "CHECKOUT-CART-002", ok: true, action: "no open bug in DEMO" },
    ]);
    expect(connection.tickets.get("DEMO-77")?.status).toBe("Done");
    expect(connection.methods()).toEqual([
      "findOpenBug",
      "postComment",
      "transition",
      "findOpenBug",
    ]);
  });

  it("keeps a failed intent's error and goes on with the next", async () => {
    const connection = new FakeTrackerConnection();
    connection.failures.createBug =
      "POST /rest/api/3/issue answered 400: issue type Bug is not valid";
    const intents = planBugs(
      inputs([result(), result({ caseId: "CHECKOUT-CART-002", status: "pass" })]),
    );

    const outcomes = await applyBugs(intents, connected(connection));

    expect(outcomes).toEqual([
      {
        caseId: "CHECKOUT-CART-001",
        ok: false,
        action: "file a bug in DEMO",
        error: "POST /rest/api/3/issue answered 400: issue type Bug is not valid",
      },
      { caseId: "CHECKOUT-CART-002", ok: true, action: "no open bug in DEMO" },
    ]);
  });

  it("names a filed bug and fails the intent when a step after the create failed", async () => {
    const connection = new FakeTrackerConnection();
    connection.bugProblems.push(
      "could not link DEMO-901 to DEMO-99: POST /rest/api/3/issueLink answered 404",
      "could not link DEMO-901 to DEMO-98: POST /rest/api/3/issueLink answered 404",
    );

    const outcomes = await applyBugs(planBugs(inputs([result()])), connected(connection));

    expect(outcomes).toEqual([
      {
        caseId: "CHECKOUT-CART-001",
        ok: false,
        action: "filed DEMO-901",
        key: "DEMO-901",
        url: "https://tracker.example.test/browse/DEMO-901",
        error:
          "could not link DEMO-901 to DEMO-99: POST /rest/api/3/issueLink answered 404; could not link DEMO-901 to DEMO-98: POST /rest/api/3/issueLink answered 404",
      },
    ]);
  });

  it("connects once per tracker and fails each intent of a tracker that cannot connect", async () => {
    const connection = new FakeTrackerConnection();
    const asked: string[] = [];
    const intents = planBugs(
      inputs([
        result(),
        result({ caseId: "CHECKOUT-CART-002", links: ["linear:ENG-4"] }),
        result({ caseId: "CHECKOUT-CART-003", status: "pass" }),
      ]),
    );

    const outcomes = await applyBugs(intents, (tracker) => {
      asked.push(tracker);
      if (tracker === "linear") throw new Error("trackers.linear.site is not set");
      return Promise.resolve(connection);
    });

    expect(asked).toEqual(["jira", "linear"]);
    expect(outcomes.map(({ caseId, ok, error }) => ({ caseId, ok, error }))).toEqual([
      { caseId: "CHECKOUT-CART-001", ok: true, error: undefined },
      { caseId: "CHECKOUT-CART-002", ok: false, error: "trackers.linear.site is not set" },
      { caseId: "CHECKOUT-CART-003", ok: true, error: undefined },
    ]);
  });
});
