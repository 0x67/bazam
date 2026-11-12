import { mkdir, mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vite-plus/test";
import { Redactor, defaultRedactionRules } from "../src/redact/index.ts";
import {
  EvidenceStore,
  newRunId,
  writeRunStatus,
  writeRunSummary,
  type CaseMeta,
  type CaseResult,
  type CheckRecord,
} from "../src/result/index.ts";

const RUN_ID = "20261106-093000-a1b2";
const CASE_ID = "AUTH-LOGIN-001";
const completed = { kind: "completed" } as const;
const finishedAt = new Date("2026-11-06T09:30:02.500Z");
const meta: CaseMeta = {
  runId: RUN_ID,
  title: "Admin signs in with a password",
  stage: "acceptance",
  env: "demo",
  target: "web",
  links: ["jira:DEMO-246"],
  identities: ["admin-1"],
  seed: 42,
  values: { amount: "4.27" },
  caseValues: {},
  steps: [],
  startedAt: new Date("2026-11-06T09:30:00.000Z"),
};
const heading: CheckRecord = {
  name: "dashboard heading",
  kind: "ui",
  expected: "Dashboard",
  observed: "Dashboard",
  ok: true,
};
const pngHeader = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

let runDir: string;

beforeEach(async () => {
  runDir = join(await mkdtemp(join(tmpdir(), "result-test-")), RUN_ID);
});

afterEach(async () => {
  await rm(dirname(runDir), { recursive: true, force: true });
});

function newStore(redactor = new Redactor(defaultRedactionRules())): EvidenceStore {
  return new EvidenceStore(runDir, CASE_ID, redactor);
}

async function readCaseFile(name: string): Promise<string> {
  return readFile(join(runDir, CASE_ID, name), "utf8");
}

describe("EvidenceStore", () => {
  it("writes result.json with every documented field", async () => {
    const store = newStore();
    store.record(heading);
    store.note("signed in as admin-1");
    store.callout("session is a demo session");
    store.followup("welcome email arrives", "check the ops@example.test inbox");
    await store.attach("Dashboard", new Uint8Array(pngHeader), "png");
    store.challenge(2, "otp-email", "otp-mailpit");

    const returned = await store.finish(completed, meta, finishedAt);
    const written: unknown = JSON.parse(await readCaseFile("result.json"));

    expect(written).toEqual({
      runId: RUN_ID,
      caseId: CASE_ID,
      title: "Admin signs in with a password",
      stage: "acceptance",
      env: "demo",
      target: "web",
      links: ["jira:DEMO-246"],
      status: "followup",
      checks: [
        heading,
        {
          name: "welcome email arrives",
          kind: "followup",
          expected: "checked by a person",
          observed: "not automated",
          ok: true,
          hint: "check the ops@example.test inbox",
        },
      ],
      notes: ["signed in as admin-1"],
      callouts: ["session is a demo session"],
      followups: [{ item: "welcome email arrives", hint: "check the ops@example.test inbox" }],
      attachments: ["01-dashboard.png"],
      challenges: [{ step: 2, kind: "otp-email", resolver: "otp-mailpit" }],
      identities: ["admin-1"],
      seed: 42,
      caseValues: {},
      steps: [],
      values: { amount: "4.27" },
      startedAt: "2026-11-06T09:30:00.000Z",
      finishedAt: "2026-11-06T09:30:02.500Z",
      durationMs: 2500,
    });
    expect(returned).toEqual(written);
  });

  it("records the reason when a harness error ends the case", async () => {
    const store = newStore();

    const result = await store.finish(
      { kind: "errored", message: "driver crashed", source: "harness" },
      meta,
      finishedAt,
    );

    expect([result.status, result.reason]).toEqual(["blocked", "internal: driver crashed"]);
  });

  it("numbers attachments in the order they were taken, also when taken concurrently", async () => {
    const store = newStore();
    const bytes = new Uint8Array(pngHeader);

    const first = await store.attach("Login page", bytes, "png");
    const rest = await Promise.all([
      store.attach("After submit!", bytes, "png"),
      store.attach("trace", bytes, "zip"),
    ]);
    const result = await store.finish(completed, meta, finishedAt);

    expect([first, ...rest]).toEqual(["01-login-page.png", "02-after-submit.png", "03-trace.zip"]);
    expect(result.attachments).toEqual([
      "01-login-page.png",
      "02-after-submit.png",
      "03-trace.zip",
    ]);
    expect((await readdir(join(runDir, CASE_ID))).sort()).toEqual([
      "01-login-page.png",
      "02-after-submit.png",
      "03-trace.zip",
      "result.json",
    ]);
  });

  it("masks registered values and sensitive keys in result.json and text attachments", async () => {
    const redactor = new Redactor(defaultRedactionRules());
    redactor.register("demo-client-secret");
    const store = newStore(redactor);
    const encode = (s: string) => new TextEncoder().encode(s);
    store.record({
      name: "token request",
      kind: "api",
      expected: 200,
      observed: "client_secret=demo-client-secret",
      ok: true,
    });
    store.note("sent demo-client-secret");

    await store.attach("log", encode("POST /token client_secret=demo-client-secret"), "txt");
    await store.attach(
      "token response",
      encode(JSON.stringify({ access_token: "fake-access-token", user: "admin-1" })),
      "json",
    );
    await store.finish(completed, meta, finishedAt);

    const resultJson = await readCaseFile("result.json");
    expect(resultJson).not.toContain("demo-client-secret");
    expect(JSON.parse(resultJson)).toMatchObject({
      checks: [{ observed: "client_secret=[redacted]" }],
      notes: ["sent [redacted]"],
    });
    expect(await readCaseFile("01-log.txt")).toBe("POST /token client_secret=[redacted]");
    expect(JSON.parse(await readCaseFile("02-token-response.json"))).toEqual({
      access_token: "[redacted]",
      user: "admin-1",
    });
  });

  it("writes png bytes unchanged even when they hold a registered value", async () => {
    const redactor = new Redactor(defaultRedactionRules());
    redactor.register("demo-client-secret");
    const png = new Uint8Array([...pngHeader, ...new TextEncoder().encode("demo-client-secret")]);

    await newStore(redactor).attach("screen", png, "png");

    expect(new Uint8Array(await readFile(join(runDir, CASE_ID, "01-screen.png")))).toEqual(png);
  });

  it("keeps a replay seed of eight or more digits as a number", async () => {
    const store = newStore();
    store.record(heading);

    const result = await store.finish(completed, { ...meta, seed: 2654435761 }, finishedAt);

    expect(result.seed).toBe(2654435761);
    expect(JSON.parse(await readCaseFile("result.json"))).toMatchObject({ seed: 2654435761 });
  });

  it("masks caseValues with the redactor but not run values", async () => {
    const store = newStore();
    store.record(heading);

    const result = await store.finish(
      completed,
      { ...meta, values: { n: "66655867" }, caseValues: { order: "66655867", note: "ok" } },
      finishedAt,
    );

    expect(result.caseValues).toEqual({ order: "••••5867", note: "ok" });
    expect(result.values).toEqual({ n: "66655867" });
    expect(JSON.parse(await readCaseFile("result.json"))).toMatchObject({
      caseValues: result.caseValues,
    });
  });

  it("keeps the step times unmasked and writes them to result.json", async () => {
    const store = newStore();
    store.record(heading);
    const steps = [
      { number: 1, kind: "66655867", list: "steps" as const, startedAt: "x", durationMs: 66655867 },
    ];

    const result = await store.finish(completed, { ...meta, steps }, finishedAt);

    expect(result.steps).toEqual(steps);
    expect(JSON.parse(await readCaseFile("result.json")).steps).toEqual(steps);
  });

  it("keeps run values and the duration readable when they hold eight or more digits", async () => {
    const store = newStore();
    store.record(heading);
    const values = { "random(10000000, 99999999, 0)": "66655867" };

    const result = await store.finish(
      completed,
      { ...meta, values, startedAt: new Date("2026-11-06T06:30:00.000Z") },
      finishedAt,
    );

    expect([result.values, result.durationMs]).toEqual([values, 10_802_500]);
    expect(JSON.parse(await readCaseFile("result.json"))).toMatchObject({
      values,
      durationMs: 10_802_500,
    });
  });

  it("lists only attachments that reached disk", async () => {
    const store = newStore();
    const png = new Uint8Array(pngHeader);
    // a folder where the first file would go makes its write fail
    await mkdir(join(runDir, CASE_ID, "01-blocked.png"), { recursive: true });

    await expect(store.attach("blocked", png, "png")).rejects.toThrow();
    await expect(
      store.attach("body", new TextEncoder().encode("not json"), "json"),
    ).rejects.toThrow();
    const written = await store.attach("retry", png, "png");
    const result = await store.finish(completed, meta, finishedAt);

    expect(written).toBe("02-retry.png");
    expect(result.attachments).toEqual(["02-retry.png"]);
    expect(JSON.parse(await readCaseFile("result.json"))).toMatchObject({
      attachments: ["02-retry.png"],
    });
  });
});

describe("writeRunSummary", () => {
  function caseResult(
    caseId: string,
    status: CaseResult["status"],
    extra: Partial<CaseResult> = {},
  ): CaseResult {
    return {
      runId: RUN_ID,
      caseId,
      title: `Title of ${caseId}`,
      stage: "acceptance",
      env: "demo",
      target: "web",
      links: [],
      status,
      checks: [heading],
      notes: [],
      callouts: [],
      followups: [],
      attachments: [],
      challenges: [],
      identities: ["admin-1"],
      seed: 42,
      values: {},
      caseValues: {},
      steps: [],
      startedAt: "2026-11-06T09:30:00.000Z",
      finishedAt: "2026-11-06T09:30:02.500Z",
      durationMs: 2500,
      ...extra,
    };
  }

  it("writes summary.json and summary.md with a row per case and a count per status", async () => {
    const results = [
      caseResult("AUTH-LOGIN-001", "pass"),
      caseResult("AUTH-LOGIN-002", "fail", {
        checks: [heading, { ...heading, name: "role badge", ok: false }],
      }),
      caseResult("BILLING-REFUND-001", "blocked", {
        reason: "internal: driver | crashed\nafter launch",
      }),
      caseResult("BILLING-REFUND-002", "followup", {
        followups: [{ item: "refund email arrives", hint: "check the ops@example.test inbox" }],
      }),
    ];

    await writeRunSummary(runDir, results);

    expect(JSON.parse(await readFile(join(runDir, "summary.json"), "utf8"))).toEqual({
      runId: RUN_ID,
      counts: { pass: 1, fail: 1, blocked: 1, followup: 1, total: 4 },
      cases: [
        {
          caseId: "AUTH-LOGIN-001",
          title: "Title of AUTH-LOGIN-001",
          target: "web",
          status: "pass",
        },
        {
          caseId: "AUTH-LOGIN-002",
          title: "Title of AUTH-LOGIN-002",
          target: "web",
          status: "fail",
        },
        {
          caseId: "BILLING-REFUND-001",
          title: "Title of BILLING-REFUND-001",
          target: "web",
          status: "blocked",
          reason: "internal: driver | crashed\nafter launch",
        },
        {
          caseId: "BILLING-REFUND-002",
          title: "Title of BILLING-REFUND-002",
          target: "web",
          status: "followup",
        },
      ],
    });
    expect(await readFile(join(runDir, "summary.md"), "utf8")).toBe(
      [
        `# Run ${RUN_ID}`,
        "",
        "1 pass, 1 fail, 1 blocked, 1 followup, 4 total.",
        "",
        "| Case | Title | Target | Status | Reason or failed checks |",
        "| --- | --- | --- | --- | --- |",
        "| AUTH-LOGIN-001 | Title of AUTH-LOGIN-001 | web | pass |  |",
        "| AUTH-LOGIN-002 | Title of AUTH-LOGIN-002 | web | fail | failed: role badge |",
        "| BILLING-REFUND-001 | Title of BILLING-REFUND-001 | web | blocked | internal: driver \\| crashed after launch |",
        "| BILLING-REFUND-002 | Title of BILLING-REFUND-002 | web | followup |  |",
        "",
        "## Follow-up",
        "",
        "| Case | Item | Hint |",
        "| --- | --- | --- |",
        "| BILLING-REFUND-002 | refund email arrives | check the ops@example.test inbox |",
        "",
      ].join("\n"),
    );
  });

  it("lists unmapped tests in summary.json and in a table at the end of summary.md", async () => {
    const unmapped = [
      { target: "shop-chrome", title: "CartTest › keeps | items", reason: "no case SHOP-CART-009" },
      {
        target: "shop-chrome",
        title: "[chromium] checkout › pays",
        reason: "no case id in the test name, its tags or the mapping file",
      },
    ];

    await writeRunSummary(
      runDir,
      [caseResult("SHOP-CART-001", "pass", { target: "shop-chrome" })],
      unmapped,
    );

    expect(JSON.parse(await readFile(join(runDir, "summary.json"), "utf8"))).toMatchObject({
      unmapped,
    });
    const markdown = await readFile(join(runDir, "summary.md"), "utf8");
    expect(markdown.slice(markdown.indexOf("## Follow-up"))).toBe(
      [
        "## Follow-up",
        "",
        "None.",
        "",
        "## Unmapped tests",
        "",
        "| Target | Test | Reason |",
        "| --- | --- | --- |",
        "| shop-chrome | CartTest › keeps \\| items | no case SHOP-CART-009 |",
        "| shop-chrome | [chromium] checkout › pays | no case id in the test name, its tags or the mapping file |",
        "",
      ].join("\n"),
    );
  });

  it("leaves both files as they were when the unmapped list is empty", async () => {
    const results = [caseResult("AUTH-LOGIN-001", "pass")];
    await writeRunSummary(runDir, results);
    const before = await Promise.all(
      ["summary.json", "summary.md"].map((name) => readFile(join(runDir, name), "utf8")),
    );

    await writeRunSummary(runDir, results, []);
    const after = await Promise.all(
      ["summary.json", "summary.md"].map((name) => readFile(join(runDir, name), "utf8")),
    );

    expect(after).toEqual(before);
    expect(JSON.parse(after[0]!)).not.toHaveProperty("unmapped");
  });
});

describe("writeRunStatus", () => {
  it("replaces status.json on each write and leaves no temporary file", async () => {
    await writeRunStatus(runDir, {
      runId: RUN_ID,
      state: "running",
      total: 2,
      pendingPrompts: 1,
      results: [],
    });
    const progress = {
      runId: RUN_ID,
      state: "finished" as const,
      total: 2,
      pendingPrompts: 0,
      results: [{ caseId: CASE_ID, status: "pass" as const }],
    };

    await writeRunStatus(runDir, progress);

    expect(JSON.parse(await readFile(join(runDir, "status.json"), "utf8"))).toEqual(progress);
    expect(await readdir(runDir)).toEqual(["status.json"]);
  });
});

describe("newRunId", () => {
  it("builds the id from the UTC clock and four hex digits of the random source", () => {
    const now = new Date("2026-11-06T09:30:05.999Z");

    expect(newRunId(now, () => 0)).toBe("20261106-093005-0000");
    expect(newRunId(now, () => 0.5)).toBe("20261106-093005-8000");
    expect(newRunId(now, () => 0.999999)).toBe("20261106-093005-ffff");
  });
});
