import { existsSync } from "node:fs";
import { basename, join } from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vite-plus/test";
import { BRAND } from "@bazam/core/brand";
import { ExitCode } from "../src/exit.ts";
import {
  fixtureProject,
  removeFixtures,
  startApi,
  type Api,
  type Fixture,
} from "./support/project.ts";

let api: Api;

beforeAll(async () => {
  api = await startApi();
});

afterAll(async () => {
  await api.close();
});

afterEach(removeFixtures);

/** Two external cases on the runner target, which name no steps and no checks. */
const CART_CASES = [
  "cases:",
  "  - id: CART-KEEP-001",
  "    title: The cart keeps items after sign-in",
  "    stage: acceptance",
  "    risk: low",
  "    links: [jira:DEMO-12]",
  "    targets: [shop-chrome]",
  "  - id: CART-EMPTY-001",
  "    title: The cart empties on checkout",
  "    stage: acceptance",
  "    risk: low",
  "    links: [jira:DEMO-12]",
  "    targets: [shop-chrome]",
  "",
].join("\n");

const RESULTS = [
  '<testsuite name="cart">',
  '  <testcase classname="Cart" name="[CART-KEEP-001] keeps items"/>',
  '  <testcase classname="Cart" name="[CART-EMPTY-001] empties"><failure message="cart not empty"/></testcase>',
  "</testsuite>",
  "",
].join("\n");

const SECRET_NAME = "INGEST_PROBE_SECRET";
const SECRET_VALUE = "probe-secret-value-xyz";

/** The fixture project plus a runner, never started here, and the runner target its cases name. */
async function runnerProject(): Promise<Fixture> {
  const project = await fixtureProject(api);
  const config = JSON.parse(await project.read(BRAND.configFile)) as {
    targets: Record<string, unknown>;
  };
  await project.write(
    BRAND.configFile,
    JSON.stringify({
      ...config,
      runners: {
        shop: { command: ["node", "suite.js"], results: "reports/*.xml", format: "junit" },
      },
      targets: { ...config.targets, "shop-chrome": { runner: "shop" } },
    }),
  );
  await project.write("cases/cart/cases.yaml", CART_CASES);
  await project.write("reports/results.xml", RESULTS);
  return project;
}

describe("ingest", () => {
  it("records the target's cases from the files as a run would, and exits by their statuses", async () => {
    const project = await runnerProject();
    // relative to the folder the CLI runs in, as --root is
    const file = join(basename(project.root), "reports", "results.xml");
    const argv = ["ingest", "--env", "demo", "--target", "shop-chrome", "--run", "in1", file];
    const { code, stdout, stderr } = await project.cli(...argv, "--json");
    expect(code, stderr).toBe(ExitCode.Fail);
    expect(JSON.parse(stdout)).toEqual({
      runId: "in1",
      counts: { pass: 1, fail: 1, blocked: 0, followup: 0, total: 2 },
      cases: [
        {
          caseId: "CART-KEEP-001",
          title: "The cart keeps items after sign-in",
          target: "shop-chrome",
          status: "pass",
        },
        {
          caseId: "CART-EMPTY-001",
          title: "The cart empties on checkout",
          target: "shop-chrome",
          status: "fail",
        },
      ],
    });
    expect(JSON.parse(await project.read("runs/in1/status.json"))).toMatchObject({
      state: "finished",
      total: 2,
    });
    expect(JSON.parse(await project.read("runs/in1/summary.json"))).toMatchObject({
      counts: { total: 2 },
    });
    const postPlan = JSON.parse(await project.read("runs/in1/post-plan.json")) as {
      items: { caseId: string }[];
    };
    expect(postPlan.items.map((item) => item.caseId)).toEqual(["CART-KEEP-001", "CART-EMPTY-001"]);
    const again = await project.cli(...argv);
    expect(again.code).toBe(ExitCode.CouldNotStart);
    expect(again.stderr).toContain("run in1 has already started");
  });

  it("masks the inherited value of a declared secret in the evidence it records", async () => {
    const project = await runnerProject();
    // the fixture loads only a module plugin, so no process plugin registers the value as it starts
    const config = JSON.parse(await project.read(BRAND.configFile)) as Record<string, unknown>;
    await project.write(
      BRAND.configFile,
      JSON.stringify({ ...config, secrets: { names: [SECRET_NAME] } }),
    );
    await project.write(
      "reports/results.xml",
      RESULTS.replace(
        '<testcase classname="Cart" name="[CART-KEEP-001] keeps items"/>',
        `<testcase classname="Cart" name="[CART-KEEP-001] keeps items"><failure message="token ${SECRET_VALUE} refused"/></testcase>`,
      ),
    );
    const before = process.env[SECRET_NAME];
    process.env[SECRET_NAME] = SECRET_VALUE;
    try {
      const file = join(project.root, "reports", "results.xml");
      const { code, stderr } = await project.cli(
        "ingest",
        "--env",
        "demo",
        "--target",
        "shop-chrome",
        "--run",
        "p1",
        file,
      );
      expect(code, stderr).toBe(ExitCode.Fail);
      const result = await project.read("runs/p1/CART-KEEP-001/result.json");
      expect(result).not.toContain(SECRET_VALUE);
      expect(result).toContain("token [redacted] refused");
    } finally {
      if (before === undefined) delete process.env[SECRET_NAME];
      else process.env[SECRET_NAME] = before;
    }
  });

  it("refuses a driver target, other than one target, no files, a file it cannot read and an empty selection", async () => {
    const project = await runnerProject();
    const file = join(project.root, "reports", "results.xml");
    const runs = [
      await project.cli("ingest", "--env", "demo", "--target", "t", file),
      await project.cli(
        "ingest",
        "--env",
        "demo",
        "--target",
        "shop-chrome",
        "--target",
        "t",
        file,
      ),
      await project.cli("ingest", "--env", "demo", file),
      await project.cli("ingest", "--env", "demo", "--target", "shop-chrome"),
      await project.cli(
        "ingest",
        "--env",
        "demo",
        "--target",
        "shop-chrome",
        join(project.root, "reports", "none.xml"),
      ),
      await project.cli(
        "ingest",
        "--env",
        "demo",
        "--target",
        "shop-chrome",
        "--case",
        "CART-NONE-001",
        file,
      ),
      await project.cli("ingest", "--target", "shop-chrome", file),
      await project.cli(
        "ingest",
        "--env",
        "demo",
        "--target",
        "shop-chrome",
        join(project.root, "reports"),
      ),
    ];
    expect(runs.map((run) => run.code)).toEqual(Array(8).fill(ExitCode.CouldNotStart));
    const errors = runs.map((run) => run.stderr.split("\n")[0]);
    expect(errors).toEqual([
      "error: target t names a driver, not a runner",
      "error: ingest takes one --target, the runner target whose runner wrote the files",
      "error: ingest takes one --target, the runner target whose runner wrote the files",
      "error: name the result files to ingest",
      expect.stringMatching(/^error: cannot read the result file .*none\.xml: ENOENT/),
      "error: no case matches the selection",
      "error: --env is required; envs: demo",
      expect.stringMatching(/^error: cannot read the result file .*reports: EISDIR/),
    ]);
    expect(existsSync(join(project.root, "runs"))).toBe(false);
  });
});
