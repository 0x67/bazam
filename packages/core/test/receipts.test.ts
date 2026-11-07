import { mkdtemp, readdir, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vite-plus/test";
import { CaseSpec } from "../src/case/index.ts";
import {
  buildPostPlans,
  loadReceipts,
  markdownTracker,
  PeopleRegistry,
  recordReceipt,
  type PostPlan,
} from "../src/report/index.ts";
import type { CaseResult } from "../src/result/index.ts";

const FIRST_RUN = "20261107-100000-ab12";
const SECOND_RUN = "20261108-100000-cd34";
const COMMENT_URL = "https://tracker.example.test/browse/TD-246?focusedCommentId=10001";

let stateDir: string;

beforeEach(async () => {
  stateDir = join(await mkdtemp(join(tmpdir(), "receipts-test-")), "state");
});

function failed(runId: string): CaseResult {
  return {
    runId,
    caseId: "AUTH-LOGIN-001",
    title: "Customer signs in with an email code",
    stage: "regression",
    env: "uat",
    target: "web",
    links: ["jira:TD-246", "jira:TD-250"],
    status: "fail",
    checks: [{ name: "dashboard shows the account", kind: "ui", expected: "visible", observed: "hidden", ok: false }],
    notes: [],
    followups: [],
    attachments: [],
    challenges: [],
    identities: ["customer"],
    seed: 7,
    values: {},
    startedAt: "2026-11-07T10:00:00.000Z",
    finishedAt: "2026-11-07T10:01:00.000Z",
    durationMs: 60_000,
  };
}

async function plan(runId: string, comment: "new" | "update"): Promise<PostPlan> {
  const spec = CaseSpec.parse({
    id: "AUTH-LOGIN-001",
    title: "Customer signs in with an email code",
    stage: "regression",
    risk: "high",
    links: ["jira:TD-246", "jira:TD-250"],
    targets: ["web"],
    report: { comment },
  });
  return buildPostPlans({
    runId,
    env: "uat",
    results: [failed(runId)],
    specs: new Map([[spec.id, spec]]),
    people: new PeopleRegistry({}),
    receipts: await loadReceipts(stateDir),
    trackers: markdownTracker,
    transitions: {},
    now: new Date("2026-11-08T10:05:00Z"),
  });
}

describe("receipts", () => {
  it("next plan edits the acked comment when comment is update, on the acked ticket only", async () => {
    const first = await plan(FIRST_RUN, "update");
    await recordReceipt(stateDir, first.items[0]!, COMMENT_URL, new Date("2026-11-07T10:10:00Z"));

    const second = await plan(SECOND_RUN, "update");

    expect(second.items.map((item) => [item.ticket.key, item.edit])).toEqual([
      ["TD-246", { url: COMMENT_URL }],
      ["TD-250", undefined],
    ]);
  });

  it("next plan posts a new comment after an ack when comment is new", async () => {
    const first = await plan(FIRST_RUN, "new");
    await recordReceipt(stateDir, first.items[0]!, COMMENT_URL, new Date("2026-11-07T10:10:00Z"));

    const second = await plan(SECOND_RUN, "new");

    expect(second.items.map((item) => item.edit)).toEqual([undefined, undefined]);
  });

  it("a later ack for the same case and ticket replaces the receipt and leaves no temp file", async () => {
    const first = await plan(FIRST_RUN, "update");
    await recordReceipt(stateDir, first.items[0]!, COMMENT_URL, new Date("2026-11-07T10:10:00Z"));
    const second = await plan(SECOND_RUN, "update");
    const laterUrl = "https://tracker.example.test/browse/TD-246?focusedCommentId=10002";

    await recordReceipt(stateDir, second.items[0]!, laterUrl, new Date("2026-11-08T10:10:00Z"));

    expect((await loadReceipts(stateDir)).latest("jira", "TD-246", "AUTH-LOGIN-001")).toEqual({
      marker: second.items[0]!.marker,
      url: laterUrl,
      postedAt: "2026-11-08T10:10:00.000Z",
    });
    expect(await readdir(stateDir)).toEqual(["receipts.json"]);
    expect(JSON.parse(await readFile(join(stateDir, "receipts.json"), "utf8"))).toHaveProperty([
      "jira:TD-246:AUTH-LOGIN-001",
    ]);
  });
});
