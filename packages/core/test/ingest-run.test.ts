import { existsSync } from "node:fs";
import { readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vite-plus/test";
import { BRAND } from "../src/brand.ts";
import { defaultRedactionRules, Redactor } from "../src/redact/index.ts";
import type { CaseResult, RunProgress } from "../src/result/index.ts";
import { ingestResults } from "../src/run/index.ts";
import { loadTestProject } from "./support/project.ts";

const RUN_ID = "20261109-120000-7a8b";
const ORDER_REF = "fake-order-ref-9931";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

function cartCase(id: string, fields: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id,
    title: `case ${id}`,
    stage: "acceptance",
    risk: "low",
    links: ["jira:DEMO-7"],
    targets: ["shop-chrome"],
    ...fields,
  };
}

const junit = (...testcases: string[]) => `<testsuite name="shop">\n${testcases.join("\n")}\n</testsuite>\n`;

interface IngestSetup {
  cases: readonly Record<string, unknown>[];
  /** Result files by name, written into the project root. */
  files: Record<string, string>;
  env?: string;
  format?: string;
  redactor?: Redactor;
}

async function ingest(setup: IngestSetup): Promise<{ results: CaseResult[]; runDir: string }> {
  const config = {
    envs: {
      demo: { production: false, hosts: ["127.0.0.1"] },
      live: { production: true, hosts: ["127.0.0.1"] },
    },
    runners: {
      shop: { command: ["node", "suite.js"], results: "reports/*.xml", format: setup.format ?? "junit" },
    },
    targets: { "shop-chrome": { runner: "shop" } },
  };
  const { root, project, registry } = await loadTestProject(
    { [BRAND.configFile]: config, "cases/shop/cart.yaml": { cases: setup.cases }, ...setup.files },
    [],
  );
  roots.push(root);
  const runDir = join(root, "runs", RUN_ID);
  const results = await ingestResults({
    project,
    env: project.config.envs[setup.env ?? "demo"]!,
    registry,
    target: "shop-chrome",
    cases: project.cases,
    files: Object.keys(setup.files).map((file) => join(root, file)),
    runDir,
    redactor: setup.redactor ?? new Redactor(defaultRedactionRules()),
    seed: 7,
  });
  return { results, runDir };
}

function outcomes(results: readonly CaseResult[]): { caseId: string; status: string; reason: string | undefined }[] {
  return results.map(({ caseId, status, reason }) => ({ caseId, status, reason }));
}

describe("ingestResults", () => {
  it("writes the results, the summary, the post plan and a finished status.json", async () => {
    const { results, runDir } = await ingest({
      cases: [cartCase("SHOP-CART-001"), cartCase("SHOP-CART-002")],
      files: {
        "reports/results.xml": junit(
          '<testcase classname="Cart" name="[SHOP-CART-001] keeps items"/>',
          '<testcase classname="Cart" name="[SHOP-CART-002] empties"><failure message="cart not empty"/></testcase>',
        ),
      },
    });
    expect(outcomes(results)).toEqual([
      { caseId: "SHOP-CART-001", status: "pass", reason: undefined },
      { caseId: "SHOP-CART-002", status: "fail", reason: undefined },
    ]);
    const status = JSON.parse(await readFile(join(runDir, "status.json"), "utf8")) as RunProgress;
    expect(status).toEqual({
      runId: RUN_ID,
      state: "finished",
      total: 2,
      pendingPrompts: 0,
      results: [
        { caseId: "SHOP-CART-001", status: "pass" },
        { caseId: "SHOP-CART-002", status: "fail" },
      ],
    });
    const summary = JSON.parse(await readFile(join(runDir, "summary.json"), "utf8")) as { counts: unknown };
    expect(summary.counts).toEqual({ pass: 1, fail: 1, blocked: 0, followup: 0, total: 2 });
    const postPlan = JSON.parse(await readFile(join(runDir, "post-plan.json"), "utf8")) as { items: unknown[] };
    expect(postPlan.items).toHaveLength(2);
    expect(existsSync(join(runDir, "SHOP-CART-001", "result.json"))).toBe(true);
  });

  it("masks a registered value in an unmapped test's title in summary.json and summary.md", async () => {
    const redactor = new Redactor(defaultRedactionRules());
    redactor.register(ORDER_REF);
    const { runDir } = await ingest({
      cases: [cartCase("SHOP-CART-001")],
      files: {
        "reports/results.xml": junit(
          '<testcase classname="Cart" name="[SHOP-CART-001] keeps items"/>',
          `<testcase classname="Cart" name="checks out order ${ORDER_REF}"/>`,
        ),
      },
      redactor,
    });
    const summary = JSON.parse(await readFile(join(runDir, "summary.json"), "utf8")) as { unmapped: unknown };
    expect(summary.unmapped).toEqual([
      {
        target: "shop-chrome",
        title: "Cart › checks out order [redacted]",
        reason: "no case id in the test name, its tags or the mapping file",
      },
    ]);
    for (const file of ["summary.json", "summary.md"])
      expect(await readFile(join(runDir, file), "utf8")).not.toContain(ORDER_REF);
    expect(await readFile(join(runDir, "summary.md"), "utf8")).toContain("Cart › checks out order [redacted]");
  });

  it("blocks a case without prod_safe in a production env and asks nothing for the runner", async () => {
    const { results } = await ingest({
      cases: [cartCase("SHOP-CART-001", { prod_safe: true }), cartCase("SHOP-CART-002")],
      files: {
        "reports/results.xml": junit(
          '<testcase classname="Cart" name="[SHOP-CART-001] keeps items"/>',
          '<testcase classname="Cart" name="[SHOP-CART-002] empties"/>',
        ),
      },
      env: "live",
    });
    expect(outcomes(results)).toEqual([
      { caseId: "SHOP-CART-001", status: "pass", reason: undefined },
      {
        caseId: "SHOP-CART-002",
        status: "blocked",
        reason: "case SHOP-CART-002 is not prod_safe and env live is production",
      },
    ]);
  });

  it("blocks the cases of a runner whose format no plugin registers, without parsing a file", async () => {
    const { results } = await ingest({
      cases: [cartCase("SHOP-CART-001")],
      files: { "reports/results.json": "not a report at all" },
      format: "ctrf",
    });
    expect(outcomes(results)).toEqual([
      {
        caseId: "SHOP-CART-001",
        status: "blocked",
        reason: "runner shop uses format ctrf, which no plugin registers",
      },
    ]);
  });

  it("writes nothing when a file cannot be read", async () => {
    const config = {
      envs: { demo: { production: false, hosts: ["127.0.0.1"] } },
      runners: { shop: { command: ["node", "suite.js"], results: "reports/*.xml", format: "junit" } },
      targets: { "shop-chrome": { runner: "shop" } },
    };
    const { root, project, registry } = await loadTestProject(
      { [BRAND.configFile]: config, "cases/shop/cart.yaml": { cases: [cartCase("SHOP-CART-001")] } },
      [],
    );
    roots.push(root);
    await writeFile(join(root, "results.xml"), junit());
    const runDir = join(root, "runs", RUN_ID);
    await expect(
      ingestResults({
        project,
        env: project.config.envs["demo"]!,
        registry,
        target: "shop-chrome",
        cases: project.cases,
        files: [join(root, "results.xml"), join(root, "missing.xml")],
        runDir,
        redactor: new Redactor(defaultRedactionRules()),
        seed: 7,
      }),
    ).rejects.toThrow("ENOENT");
    expect(existsSync(runDir)).toBe(false);
  });
});
