import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  truncate,
  utimes,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vite-plus/test";
import { BRAND } from "../src/brand.ts";
import { CaseSpec } from "../src/case/index.ts";
import type { ExternalTest } from "../src/ingest/format.ts";
import { recordExternalResults, type ExternalRecordInputs } from "../src/ingest/record.ts";
import { Redactor, defaultRedactionRules } from "../src/redact/index.ts";

const RUN_ID = "20261108-101500-c3d4";
const CASE_ID = "SHOP-CART-001";
const startedAt = new Date("2026-11-08T10:15:00.000Z");
const finishedAt = new Date("2026-11-08T10:16:30.000Z");

let root: string;
let outside: string;
let spawnedAt: Date;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "record-test-"));
  outside = await mkdtemp(join(tmpdir(), "record-outside-"));
  spawnedAt = new Date();
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
  await rm(outside, { recursive: true, force: true });
});

function caseSpec(id: string): CaseSpec {
  return CaseSpec.parse({
    id,
    title: `Title of ${id}`,
    stage: "acceptance",
    risk: "medium",
    links: ["jira:DEMO-12"],
    targets: ["shop-chrome"],
  });
}

function externalTest(name: string, extra: Partial<ExternalTest> = {}): ExternalTest {
  return {
    title: ["CartTest", name],
    tags: [],
    outcome: "passed",
    retries: 0,
    attachments: [],
    source: "results/junit.xml",
    ...extra,
  };
}

function inputs(extra: Partial<ExternalRecordInputs> = {}): ExternalRecordInputs {
  return {
    runDir: join(root, "runs", RUN_ID),
    runId: RUN_ID,
    envName: "demo",
    target: "shop-chrome",
    runnerName: "shop-selenium",
    runnerCwd: root,
    root,
    stateDir: join(root, BRAND.stateDir),
    cases: [caseSpec(CASE_ID)],
    tests: new Map(),
    challenges: new Map(),
    seed: 42,
    startedAt,
    finishedAt,
    redactor: new Redactor(defaultRedactionRules()),
    ...extra,
  };
}

async function put(path: string, content: string | Uint8Array): Promise<string> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, content);
  return path;
}

async function caseFile(name: string): Promise<string> {
  return readFile(join(root, "runs", RUN_ID, CASE_ID, name), "utf8");
}

describe("recordExternalResults outcomes", () => {
  it("fails on a failed or errored test, blocks on a skipped one, and blocks a case with no test", async () => {
    const ids = [
      "SHOP-CART-001",
      "SHOP-CART-002",
      "SHOP-CART-003",
      "SHOP-CART-004",
      "SHOP-CART-005",
    ];
    const tests = new Map([
      [ids[0]!, [externalTest("flaky", { retries: 2 }), externalTest("steady")]],
      [
        ids[1]!,
        [
          externalTest("counts items", { outcome: "failed", message: "expected 2 items, got 1" }),
          externalTest("pending", { outcome: "skipped" }),
        ],
      ],
      [
        ids[2]!,
        [externalTest("keeps items"), externalTest("needs a coupon", { outcome: "skipped" })],
      ],
      [ids[3]!, [externalTest("loads", { outcome: "errored", message: "setup threw" })]],
    ]);

    const results = await recordExternalResults(inputs({ cases: ids.map(caseSpec), tests }));

    expect(results.map(({ caseId, status, reason }) => [caseId, status, reason])).toEqual([
      ["SHOP-CART-001", "pass", undefined],
      ["SHOP-CART-002", "fail", undefined],
      ["SHOP-CART-003", "blocked", "skipped: CartTest › needs a coupon"],
      ["SHOP-CART-004", "fail", undefined],
      ["SHOP-CART-005", "blocked", "no result from runner shop-selenium for SHOP-CART-005"],
    ]);
    expect(results.map((result) => result.checks)).toEqual([
      [
        {
          name: "CartTest › flaky",
          kind: "external",
          expected: "passed",
          observed: "passed after 2 retries",
          ok: true,
        },
        {
          name: "CartTest › steady",
          kind: "external",
          expected: "passed",
          observed: "passed",
          ok: true,
        },
      ],
      [
        {
          name: "CartTest › counts items",
          kind: "external",
          expected: "passed",
          observed: "failed",
          ok: false,
          hint: "expected 2 items, got 1",
        },
      ],
      [
        {
          name: "CartTest › keeps items",
          kind: "external",
          expected: "passed",
          observed: "passed",
          ok: true,
        },
      ],
      [
        {
          name: "CartTest › loads",
          kind: "external",
          expected: "passed",
          observed: "errored",
          ok: false,
          hint: "setup threw",
        },
      ],
      [],
    ]);
  });

  it("writes no callouts for an external case", async () => {
    const tests = new Map([[CASE_ID, [externalTest("keeps items")]]]);

    const [result] = await recordExternalResults(inputs({ tests }));

    expect(result?.callouts).toEqual([]);
  });

  it("blocks only the cases with no test when the suite ended early", async () => {
    const failure = "runner shop-selenium timed out after 60 min";
    const tests = new Map([[CASE_ID, [externalTest("keeps items")]]]);

    const results = await recordExternalResults(
      inputs({ cases: [caseSpec(CASE_ID), caseSpec("SHOP-CART-002")], tests, failure }),
    );

    expect(results.map(({ caseId, status, reason }) => [caseId, status, reason])).toEqual([
      [CASE_ID, "pass", undefined],
      ["SHOP-CART-002", "blocked", failure],
    ]);
  });

  it("writes result.json with no identities or values and the challenges the service answered", async () => {
    const challenges = new Map([
      [CASE_ID, [{ step: 0, kind: "otp-email", resolver: "otp-mailpit" }]],
    ]);
    const tests = new Map([[CASE_ID, [externalTest("keeps items", { project: "chromium" })]]]);

    const [returned] = await recordExternalResults(inputs({ tests, challenges }));

    expect(JSON.parse(await caseFile("result.json"))).toEqual(returned);
    expect(returned).toMatchObject({
      runId: RUN_ID,
      caseId: CASE_ID,
      title: "Title of SHOP-CART-001",
      stage: "acceptance",
      env: "demo",
      target: "shop-chrome",
      links: ["jira:DEMO-12"],
      status: "pass",
      checks: [{ name: "[chromium] CartTest › keeps items" }],
      challenges: [{ step: 0, kind: "otp-email", resolver: "otp-mailpit" }],
      identities: [],
      values: {},
      caseValues: {},
      seed: 42,
      startedAt: "2026-11-08T10:15:00.000Z",
      finishedAt: "2026-11-08T10:16:30.000Z",
    });
  });
});

describe("recordExternalResults attachments", () => {
  const pngBytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

  async function record(
    attachments: ExternalTest["attachments"],
    extra: Partial<ExternalRecordInputs>,
  ) {
    const tests = new Map([[CASE_ID, [externalTest("keeps items", { attachments })]]]);
    const [result] = await recordExternalResults(inputs({ tests, ...extra }));
    return result!;
  }

  it("copies screenshots and masked text from beside the result file, then from the cwd", async () => {
    const redactor = new Redactor(defaultRedactionRules());
    redactor.register("demo-runner-secret");
    await put(join(root, "results", "shots", "home.png"), pngBytes);
    await put(join(root, "logs", "console.log"), "sent demo-runner-secret");
    await put(join(root, "results", "stdout.txt"), "token demo-runner-secret");
    await put(join(root, "stdout.txt"), "the cwd copy, read only when the results folder has none");
    const body = await put(
      join(root, "out", "body.json"),
      JSON.stringify({ access_token: "fake-access-token", user: "customer-1" }),
    );

    const result = await record(
      [
        { name: "home", path: "shots/home.png", contentType: "image/png" },
        { name: "console", path: "logs/console.log" },
        { name: "stdout", path: "stdout.txt" },
        { name: "body", path: body },
      ],
      { redactor, spawnedAt },
    );

    expect([result.attachments, result.notes]).toEqual([
      ["01-home.png", "02-console.txt", "03-stdout.txt", "04-body.json"],
      [],
    ]);
    expect(
      new Uint8Array(await readFile(join(root, "runs", RUN_ID, CASE_ID, "01-home.png"))),
    ).toEqual(pngBytes);
    expect(await caseFile("02-console.txt")).toBe("sent [redacted]");
    expect(await caseFile("03-stdout.txt")).toBe("token [redacted]");
    expect(JSON.parse(await caseFile("04-body.json"))).toEqual({
      access_token: "[redacted]",
      user: "customer-1",
    });
  });

  it("leaves out a file outside the cwd, in the state dir or the runs folder, or older than the spawn", async () => {
    const leak = await put(join(outside, "leak.txt"), "outside the cwd");
    await symlink(leak, join(root, "link.txt"));
    await put(join(root, BRAND.stateDir, "cache.json"), "{}");
    await put(join(root, "runs", "20261107-090000-a1b2", CASE_ID, "01-home.png"), pngBytes);
    const stale = await put(join(root, "stale.log"), "an earlier run");
    await utimes(
      stale,
      new Date(spawnedAt.getTime() - 10_000),
      new Date(spawnedAt.getTime() - 10_000),
    );
    // within 2 s of the spawn, for file systems with coarse timestamps
    const coarse = await put(join(root, "coarse.log"), "this run");
    await utimes(
      coarse,
      new Date(spawnedAt.getTime() - 1500),
      new Date(spawnedAt.getTime() - 1500),
    );

    const result = await record(
      [
        { name: "leak", path: leak },
        { name: "link", path: "link.txt" },
        { name: "cache", path: `${BRAND.stateDir}/cache.json` },
        { name: "earlier", path: `runs/20261107-090000-a1b2/${CASE_ID}/01-home.png` },
        { name: "stale", path: "stale.log" },
        { name: "coarse", path: "coarse.log" },
      ],
      { spawnedAt },
    );

    expect([result.attachments, result.notes]).toEqual([
      ["01-coarse.txt"],
      [
        "left out leak: not a file this runner wrote",
        "left out link: not a file this runner wrote",
        "left out cache: not a file this runner wrote",
        "left out earlier: not a file this runner wrote",
        "left out stale: not a file this runner wrote",
      ],
    ]);
  });

  it("copies a file older than the spawn in ingest, which has no spawn time", async () => {
    const stale = await put(join(root, "stale.log"), "written by the suite before ingest");
    await utimes(stale, new Date("2026-11-01T00:00:00Z"), new Date("2026-11-01T00:00:00Z"));

    const result = await record([{ name: "stale", path: "stale.log" }], {});

    expect([result.attachments, result.notes]).toEqual([["01-stale.txt"], []]);
  });

  it("notes a file too big, of another type, missing, or not valid JSON", async () => {
    const big = await put(join(root, "big.txt"), "");
    await truncate(big, 20 * 1024 * 1024 + 1);
    await put(join(root, "trace.zip"), "PK");
    await put(join(root, "broken.json"), "not json");

    const result = await record(
      [
        { name: "big", path: "big.txt" },
        { name: "trace", path: "trace.zip" },
        { name: "video", path: "video.webm" },
        { name: "missing", path: "missing.png" },
        { name: "broken", path: "broken.json" },
      ],
      { spawnedAt },
    );

    expect([result.attachments, result.notes]).toEqual([
      [],
      [
        "left out big: larger than 20 MiB",
        "left out trace: zip files from a runner are not copied",
        "left out video: webm files from a runner are not copied",
        "attachment missing was not found",
        "left out broken: not valid JSON",
      ],
    ]);
  });
});
