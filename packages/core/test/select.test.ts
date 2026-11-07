import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vite-plus/test";
import { CaseSpec, loadSuites, selectCases, type LoadedCase } from "../src/case/index.ts";

function loaded(domain: string, fields: Partial<CaseSpec> & { id: string }): LoadedCase {
  const spec = CaseSpec.parse({ title: "A journey", stage: "acceptance", risk: "low", targets: ["web"], ...fields });
  return { spec, domain, source: { file: `cases/${domain}/journeys.yaml`, line: 2 } };
}

const cases = [
  loaded("auth", { id: "AUTH-LOGIN-001", stage: "acceptance", links: ["jira:TD-246"], tags: ["smoke"] }),
  loaded("auth", {
    id: "AUTH-LOGIN-002",
    stage: "regression",
    targets: ["web", "web-chrome"],
    tags: ["smoke", "slow"],
  }),
  loaded("auth", { id: "AUTH-RESET-001", stage: "draft", links: ["jira:TD-300"] }),
  loaded("billing", { id: "BILLING-REFUND-001", stage: "regression", targets: ["web-chrome"], tags: ["smoke"] }),
  loaded("billing", { id: "BILLING-REFUND-002", stage: "retired", tags: ["smoke"] }),
];
const ids = (selected: readonly LoadedCase[]) => selected.map((c) => c.spec.id);

async function projectWithSuites(text: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "select-test-"));
  await writeFile(join(root, "suites.yaml"), text);
  return root;
}

describe("selectCases", () => {
  it("filters AND across fields and OR within one", () => {
    expect(ids(selectCases(cases, { domains: ["auth"], tags: ["smoke"] }))).toEqual([
      "AUTH-LOGIN-001",
      "AUTH-LOGIN-002",
    ]);
    expect(ids(selectCases(cases, { links: ["jira:TD-246", "jira:TD-300"] }))).toEqual([
      "AUTH-LOGIN-001",
      "AUTH-RESET-001",
    ]);
    expect(ids(selectCases(cases, { targets: ["web-chrome"], stages: ["regression"] }))).toEqual([
      "AUTH-LOGIN-002",
      "BILLING-REFUND-001",
    ]);
    expect(ids(selectCases(cases, { ids: ["AUTH-LOGIN-001", "BILLING-REFUND-001"], domains: ["billing"] }))).toEqual([
      "BILLING-REFUND-001",
    ]);
  });

  it("default keeps draft, acceptance, regression", () => {
    expect(ids(selectCases(cases, {}))).toEqual([
      "AUTH-LOGIN-001",
      "AUTH-LOGIN-002",
      "AUTH-RESET-001",
      "BILLING-REFUND-001",
    ]);
    expect(ids(selectCases(cases, { stages: ["retired"] }))).toEqual(["BILLING-REFUND-002"]);
  });
});

describe("loadSuites", () => {
  it("suite combines filters", async () => {
    const root = await projectWithSuites(`# named selections for --suite
smoke:
  tags: [smoke]
  stages: [acceptance, regression]
chrome-billing:
  domains: [billing]
  targets: [web-chrome]
`);

    const suites = await loadSuites(root);

    expect([...suites.keys()]).toEqual(["smoke", "chrome-billing"]);
    expect(ids(selectCases(cases, suites.get("smoke")!))).toEqual([
      "AUTH-LOGIN-001",
      "AUTH-LOGIN-002",
      "BILLING-REFUND-001",
    ]);
    expect(ids(selectCases(cases, suites.get("chrome-billing")!))).toEqual(["BILLING-REFUND-001"]);
  });

  it("returns no suites when suites.yaml is missing or holds only comments", async () => {
    const empty = await mkdtemp(join(tmpdir(), "select-test-"));

    expect((await loadSuites(empty)).size).toBe(0);
    expect((await loadSuites(await projectWithSuites("# no suites yet\n"))).size).toBe(0);
  });

  it("rejects a suite with an unknown field or stage and names the suite", async () => {
    await expect(loadSuites(await projectWithSuites("smoke:\n  tag: [smoke]\n"))).rejects.toThrow(/smoke/);
    await expect(loadSuites(await projectWithSuites("nightly:\n  stages: [released]\n"))).rejects.toThrow(/nightly/);
  });
});
