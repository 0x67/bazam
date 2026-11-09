import { existsSync } from "node:fs";
import { mkdir, readdir, readFile, rm, utimes, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { z } from "zod";
import { BRAND } from "../src/brand.ts";
import {
  CASES_VAR,
  CHALLENGE_TOKEN_VAR,
  CHALLENGE_URL_VAR,
  ENV_VAR,
  RUN_ID_VAR,
  type ChallengeResolver,
} from "../src/challenge/index.ts";
import type { StepHandler } from "../src/driver/index.ts";
import { RunValues } from "../src/env/index.ts";
import { definePlugin, PLUGIN_API_VERSION } from "../src/plugin/index.ts";
import { defaultRedactionRules, Redactor } from "../src/redact/index.ts";
import type { CaseResult, RunProgress } from "../src/result/index.ts";
import { runCases } from "../src/run/index.ts";
import { fakeDriver, type FakeDriver } from "./support/fake-driver.ts";
import { loadTestProject } from "./support/project.ts";

const RUN_ID = "20261109-101500-5e6f";
const SUITE = fileURLToPath(new URL("./fixtures/runners/suite.ts", import.meta.url));
const SUITE_COMMAND = [
  process.execPath,
  SUITE,
  CASES_VAR,
  CHALLENGE_URL_VAR,
  CHALLENGE_TOKEN_VAR,
  RUN_ID_VAR,
  ENV_VAR,
  "JIRA_API_TOKEN",
];
const DEMO_TOKEN = "fake-suite-token-5e1f0c";
const JIRA_TOKEN = "fake-jira-token-77aa31";

let cancel: AbortController;

beforeEach(() => {
  cancel = new AbortController();
  vi.stubEnv("SUITE_DEMO_TOKEN", DEMO_TOKEN);
  vi.stubEnv("JIRA_API_TOKEN", JIRA_TOKEN);
});

const roots: string[] = [];

afterEach(async () => {
  vi.unstubAllEnvs();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

const otpResolver: ChallengeResolver = {
  name: "fake-otp",
  kinds: ["otp-email"],
  requires: [],
  automated: true,
  resolve: async () => ({ kind: "value", value: "731904" }),
};

const expectStep: StepHandler = {
  kind: "expect",
  schema: z.unknown(),
  run: async (_payload, ctx) => {
    ctx.evidence.record({ name: "home is visible", kind: "ui", expected: "visible", observed: "visible", ok: true });
  },
};

type CaseFields = Record<string, unknown>;

function externalCase(id: string, fields: CaseFields = {}): CaseFields {
  return {
    id,
    title: `case ${id}`,
    stage: "acceptance",
    risk: "low",
    links: ["jira:TD-7"],
    targets: ["shop-chrome"],
    ...fields,
  };
}

const nativeCase = (id: string): CaseFields => externalCase(id, { targets: ["web"], steps: [{ expect: {} }] });

interface SuiteSetup {
  cases: readonly CaseFields[];
  /** Fields of the runner, over the defaults. */
  runner?: Record<string, unknown>;
  env?: string;
  driver?: FakeDriver;
  workers?: number;
}

interface Prepared {
  root: string;
  runDir: string;
  run(): Promise<CaseResult[]>;
}

async function prepare(setup: SuiteSetup): Promise<Prepared> {
  const driver = setup.driver ?? fakeDriver({ steps: [expectStep] });
  const plugin = definePlugin({
    name: "test-external",
    apiVersion: PLUGIN_API_VERSION,
    drivers: [driver],
    resolvers: [otpResolver],
  });
  const config = {
    envs: {
      demo: { production: false, hosts: ["127.0.0.1"], challenges: { "otp-email": ["fake-otp"] } },
      live: { production: true, hosts: ["127.0.0.1"] },
    },
    secrets: { providers: ["env"], names: ["SUITE_DEMO_TOKEN"] },
    identities: { customer: {} },
    trackers: { jira: { secrets: { token: "JIRA_API_TOKEN" } } },
    runners: {
      shop: {
        command: SUITE_COMMAND,
        results: "reports/*.xml",
        format: "junit",
        env: { SUITE_REPORT: "report.json" },
        ...setup.runner,
      },
    },
    targets: { web: { driver: "fake" }, "shop-chrome": { runner: "shop" } },
  };
  const { root, project, registry } = await loadTestProject(
    { [BRAND.configFile]: config, "cases/shop/cart.yaml": { cases: setup.cases } },
    [plugin],
  );
  roots.push(root);
  const runDir = join(root, "runs", RUN_ID);
  const run = () =>
    runCases({
      project,
      env: project.config.envs[setup.env ?? "demo"]!,
      cases: project.cases,
      registry,
      channel: { ask: async () => ({ kind: "timeout" }) },
      runDir,
      runValues: new RunValues(RUN_ID, new Date("2026-11-09T10:15:00Z"), 7),
      seed: 7,
      redactor: new Redactor(defaultRedactionRules()),
      signal: cancel.signal,
      ...(setup.workers === undefined ? {} : { workers: setup.workers }),
    });
  return { root, runDir, run };
}

async function runSuite(setup: SuiteSetup): Promise<{ results: CaseResult[]; root: string; runDir: string }> {
  const prepared = await prepare(setup);
  return { ...prepared, results: await prepared.run() };
}

function outcomes(results: readonly CaseResult[]): { caseId: string; status: string; reason: string | undefined }[] {
  return results.map(({ caseId, status, reason }) => ({ caseId, status, reason }));
}

async function readJson<T>(file: string): Promise<T> {
  return JSON.parse(await readFile(file, "utf8")) as T;
}

async function waitFor(file: string): Promise<void> {
  for (let tries = 0; !existsSync(file); tries += 1) {
    if (tries > 500) throw new Error(`${file} did not appear`);
    await sleep(10);
  }
}

const runnerLog = (runDir: string) => readFile(join(runDir, "runner-shop-chrome", "runner.log"), "utf8");

describe("runCases with external suites", () => {
  it("records external and native cases in one run, with the five variables in the runner's environment", async () => {
    const { results, root, runDir } = await runSuite({
      cases: [
        externalCase("SHOP-CART-001"),
        externalCase("SHOP-CART-002"),
        nativeCase("SHOP-HOME-001"),
        externalCase("SHOP-OLD-001", { stage: "retired" }),
      ],
      runner: { env: { SUITE_REPORT: "report.json", SUITE_FAIL: "SHOP-CART-002", SUITE_UNMAPPED: "untagged test" } },
    });
    expect(outcomes(results)).toEqual([
      { caseId: "SHOP-CART-001", status: "pass", reason: undefined },
      { caseId: "SHOP-CART-002", status: "fail", reason: undefined },
      { caseId: "SHOP-HOME-001", status: "pass", reason: undefined },
      { caseId: "SHOP-OLD-001", status: "blocked", reason: "stage retired does not run" },
    ]);
    expect(results[1]?.checks).toEqual([
      expect.objectContaining({ name: "Shop › [SHOP-CART-002] works", kind: "external", ok: false }),
    ]);
    // the blocked case is left out of the case ids, and the tracker token out of the environment
    expect(await readJson(join(root, "report.json"))).toEqual({
      [CASES_VAR]: "SHOP-CART-001,SHOP-CART-002",
      [CHALLENGE_URL_VAR]: expect.stringMatching(/^http:\/\/127\.0\.0\.1:\d+\/challenge$/),
      [CHALLENGE_TOKEN_VAR]: expect.stringMatching(/^[0-9a-f]{64}$/),
      [RUN_ID_VAR]: RUN_ID,
      [ENV_VAR]: "demo",
      JIRA_API_TOKEN: null,
    });
    const summary = await readJson<{ cases: { caseId: string }[]; unmapped: unknown }>(join(runDir, "summary.json"));
    expect(summary.cases.map((entry) => entry.caseId)).toEqual([
      "SHOP-CART-001",
      "SHOP-CART-002",
      "SHOP-HOME-001",
      "SHOP-OLD-001",
    ]);
    expect(summary.unmapped).toEqual([
      {
        target: "shop-chrome",
        title: "Shop › untagged test",
        reason: "no case id in the test name, its tags or the mapping file",
      },
    ]);
    expect(await readJson<RunProgress>(join(runDir, "status.json"))).toMatchObject({ state: "finished", total: 4 });
  });

  it("masks an inherited declared secret in runner.log and the run log", async () => {
    const { runDir } = await runSuite({
      cases: [externalCase("SHOP-CART-001")],
      runner: { env: { SUITE_PRINT_VAR: "SUITE_DEMO_TOKEN" } },
    });
    expect(await runnerLog(runDir)).toContain("value of SUITE_DEMO_TOKEN: [redacted]");
    const runLog = await readFile(join(runDir, "run.log"), "utf8");
    expect(runLog).toContain("[shop-chrome] value of SUITE_DEMO_TOKEN: [redacted]");
    for (const text of [await runnerLog(runDir), runLog]) expect(text).not.toContain(DEMO_TOKEN);
  });

  it.each([
    [
      "the command cannot start",
      { command: ["no-such-runner-command-0001"] },
      "runner shop could not start: spawn no-such-runner-command-0001 ENOENT",
    ],
    [
      "it writes no result file",
      { env: { SUITE_NO_RESULTS: "1", SUITE_EXIT: "1" } },
      "runner shop exited 1 and wrote no results matching reports/*.xml",
    ],
    [
      "no result file parses",
      { env: { SUITE_GARBAGE: "1" } },
      expect.stringMatching(/^reports\/results\.xml: .+ \(line \d+, column \d+\)$/),
    ],
  ])("blocks every case of the suite when %s", async (_label, runner, reason) => {
    const { results } = await runSuite({
      cases: [externalCase("SHOP-CART-001"), externalCase("SHOP-CART-002")],
      runner,
    });
    expect(outcomes(results)).toEqual([
      { caseId: "SHOP-CART-001", status: "blocked", reason },
      { caseId: "SHOP-CART-002", status: "blocked", reason },
    ]);
  });

  it("logs a result file that does not parse", async () => {
    const { runDir } = await runSuite({
      cases: [externalCase("SHOP-CART-001")],
      runner: { env: { SUITE_GARBAGE: "1" } },
    });
    expect(await readFile(join(runDir, "run.log"), "utf8")).toMatch(/^\[shop-chrome\] reports\/results\.xml: .+$/m);
  });

  it("keeps the results written before a timeout and blocks the other cases with it", async () => {
    const { results } = await runSuite({
      cases: [externalCase("SHOP-CART-001"), externalCase("SHOP-CART-002")],
      runner: { timeoutMinutes: 0.02, env: { SUITE_WRITE: "SHOP-CART-001", SUITE_HANG: "1" } },
    });
    expect(outcomes(results)).toEqual([
      { caseId: "SHOP-CART-001", status: "pass", reason: undefined },
      { caseId: "SHOP-CART-002", status: "blocked", reason: "runner shop timed out after 0.02 min" },
    ]);
  });

  it("sends SIGKILL to a runner that ignores the SIGTERM of a timeout", { timeout: 30_000 }, async () => {
    const { results, root } = await runSuite({
      cases: [externalCase("SHOP-CART-001")],
      runner: {
        timeoutMinutes: 0.02,
        env: { SUITE_HANG: "1", SUITE_NO_RESULTS: "1", SUITE_IGNORE_TERM: "1", SUITE_SIGNAL_FILE: "signal.txt" },
      },
    });
    expect(outcomes(results)).toEqual([
      { caseId: "SHOP-CART-001", status: "blocked", reason: "runner shop timed out after 0.02 min" },
    ]);
    expect(await readFile(join(root, "signal.txt"), "utf8")).toBe("SIGTERM\n");
  });

  it("stops the runner with SIGINT on cancel and reads none of its files", async () => {
    const prepared = await prepare({
      cases: [externalCase("SHOP-CART-001")],
      runner: { env: { SUITE_HANG: "1", SUITE_URL_FILE: "url.txt", SUITE_SIGNAL_FILE: "signal.txt" } },
    });
    const running = prepared.run();
    // the runner writes its results before it hangs
    await waitFor(join(prepared.root, "reports", "results.xml"));
    cancel.abort();
    expect(outcomes(await running)).toEqual([{ caseId: "SHOP-CART-001", status: "blocked", reason: "run cancelled" }]);
    expect(await readFile(join(prepared.root, "signal.txt"), "utf8")).toBe("SIGINT\n");
  });

  it("reads only the result files written after the runner started, and logs the older ones", async () => {
    const prepared = await prepare({
      cases: [externalCase("SHOP-CART-001"), externalCase("SHOP-CART-002")],
      runner: { env: { SUITE_WRITE: "SHOP-CART-001" } },
    });
    const old = join(prepared.root, "reports", "old.xml");
    await mkdir(join(prepared.root, "reports"), { recursive: true });
    await writeFile(
      old,
      '<testsuite name="shop"><testcase classname="Shop" name="[SHOP-CART-002] works"/></testsuite>',
    );
    const minuteAgo = new Date(Date.now() - 60_000);
    await utimes(old, minuteAgo, minuteAgo);
    expect(outcomes(await prepared.run())).toEqual([
      { caseId: "SHOP-CART-001", status: "pass", reason: undefined },
      { caseId: "SHOP-CART-002", status: "blocked", reason: "no result from runner shop for SHOP-CART-002" },
    ]);
    expect(await readFile(join(prepared.runDir, "run.log"), "utf8")).toContain(
      "[shop-chrome] skipped reports/old.xml: written before this run's runner started",
    );
    expect(existsSync(old)).toBe(true);
  });

  it("starts no runner when every selected case is blocked", async () => {
    const { results, root, runDir } = await runSuite({ cases: [externalCase("SHOP-CART-001")], env: "live" });
    expect(outcomes(results)).toEqual([
      {
        caseId: "SHOP-CART-001",
        status: "blocked",
        reason: "case SHOP-CART-001 is not prod_safe and env live is production",
      },
    ]);
    expect(existsSync(join(root, "report.json"))).toBe(false);
    expect(existsSync(join(runDir, "runner-shop-chrome"))).toBe(false);
  });

  it("logs a challenge request in run.log and lists the answered challenge in the case's result", async () => {
    const { results, runDir } = await runSuite({
      cases: [externalCase("SHOP-CART-001"), nativeCase("SHOP-HOME-001")],
      runner: { env: { SUITE_ASK: "SHOP-CART-001" } },
    });
    expect(outcomes(results).map(({ status }) => status)).toEqual(["pass", "pass"]);
    expect(results[0]?.challenges).toEqual([{ step: 1, kind: "otp-email", resolver: "fake-otp" }]);
    const written = await readJson<CaseResult>(join(runDir, "SHOP-CART-001", "result.json"));
    expect(written.challenges).toEqual([{ step: 1, kind: "otp-email", resolver: "fake-otp" }]);
    expect(await readFile(join(runDir, "run.log"), "utf8")).toContain(
      "challenge otp-email for SHOP-CART-001: answered by fake-otp",
    );
    const files = await readdir(runDir, { recursive: true });
    const caseLogs = files.filter((file) => file.endsWith("case.log"));
    for (const file of caseLogs)
      expect(await readFile(join(runDir, file), "utf8")).not.toContain("challenge otp-email");
  });

  it("settles the run and stops the challenge service when the first launch fails beside a suite", async () => {
    let root = "";
    const inner = fakeDriver({ steps: [expectStep], failingLaunches: [1] });
    // the launch fails only once the suite runs and has written the service's URL
    const driver: FakeDriver = {
      ...inner,
      launch: async (options) => {
        await waitFor(join(root, "url.txt"));
        return inner.launch(options);
      },
    };
    const prepared = await prepare({
      cases: [nativeCase("SHOP-HOME-001"), externalCase("SHOP-CART-001")],
      runner: { env: { SUITE_HANG: "1", SUITE_URL_FILE: "url.txt" } },
      driver,
      workers: 2,
    });
    root = prepared.root;
    await expect(prepared.run()).rejects.toThrow("could not launch target web: fake launch 1 failed");
    const url = await readFile(join(root, "url.txt"), "utf8");
    await expect(fetch(url, { method: "POST" })).rejects.toMatchObject({ cause: { code: "ECONNREFUSED" } });
    const suite = await readJson<CaseResult>(join(prepared.runDir, "SHOP-CART-001", "result.json"));
    expect(suite).toMatchObject({ status: "blocked", reason: "run cancelled" });
  });
});
