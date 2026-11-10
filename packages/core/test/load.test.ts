import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vite-plus/test";
import { CaseSpec, loadCases } from "../src/case/index.ts";

const fixture = (name: string) => fileURLToPath(new URL(`./fixtures/cases/${name}`, import.meta.url));

describe("loadCases", () => {
  it("loads every case under cases/<domain>/ with its domain and the line of its list item", async () => {
    const load = await loadCases(fixture("valid"), CaseSpec);

    expect(load.issues).toEqual([]);
    expect(load.cases.map((c) => [c.spec.id, c.domain, c.source.file, c.source.line])).toEqual([
      ["AUTH-LOGIN-001", "auth", "cases/auth/login.yaml", 3],
      ["AUTH-LOGIN-002", "auth", "cases/auth/login.yaml", 20],
      ["BILLING-REFUND-001", "billing", "cases/billing/refund.yaml", 2],
    ]);
    expect([...load.retiredIds]).toEqual(["AUTH-OLD-001"]);
  });

  it("reports duplicate, retired, wrong-domain and malformed ids once each on the id line", async () => {
    const load = await loadCases(fixture("broken"), CaseSpec);
    const idIssues = load.issues.filter(
      (issue) => issue.ruleId.startsWith("id-") && issue.file === "cases/auth/ids.yaml",
    );

    expect(idIssues.map((issue) => [issue.ruleId, issue.file, issue.line])).toEqual([
      ["id-format", "cases/auth/ids.yaml", 23],
      ["id-unique", "cases/auth/ids.yaml", 9],
      ["id-retired", "cases/auth/ids.yaml", 13],
      ["id-domain", "cases/auth/ids.yaml", 18],
    ]);
    expect(idIssues.find((issue) => issue.ruleId === "id-unique")?.message).toContain("cases/auth/ids.yaml:3");
    expect(idIssues.find((issue) => issue.ruleId === "id-domain")?.fix).toContain("AUTH-");
    expect(idIssues.every((issue) => issue.severity === "error" && issue.fix !== "")).toBe(true);
  });

  it("applies the id rules to cases that fail the schema, and reserves their ids", async () => {
    const load = await loadCases(fixture("broken"), CaseSpec);
    const issues = load.issues.filter((issue) => issue.file === "cases/auth/schema-ids.yaml");

    expect(issues.filter((issue) => issue.ruleId.startsWith("id-")).map((issue) => [issue.ruleId, issue.line])).toEqual(
      [
        ["id-retired", 3],
        ["id-domain", 9],
        ["id-unique", 19],
      ],
    );
    expect(issues.filter((issue) => issue.ruleId === "schema")).toHaveLength(3);
    expect(issues.find((issue) => issue.ruleId === "id-unique")?.message).toContain("cases/auth/schema-ids.yaml:13");
  });

  it("keeps only the cases without issues, and the first case of a duplicated id", async () => {
    const load = await loadCases(fixture("broken"), CaseSpec);

    expect(load.cases.map((c) => [c.spec.id, c.source.line])).toEqual([["AUTH-LOGIN-001", 3]]);
  });

  it("maps schema issues to the line of the offending key in block and flow style", async () => {
    const load = await loadCases(fixture("broken"), CaseSpec);
    const schemaIssues = load.issues.filter((issue) => issue.file === "cases/auth/schema.yaml");

    expect(schemaIssues.map((issue) => [issue.ruleId, issue.line])).toEqual([
      ["schema", 7],
      ["schema", 15],
      ["schema", 24],
      ["schema", 25],
    ]);
    expect(schemaIssues[1]?.message).toMatch(
      /^steps\[1\]\.hover: unknown step kind "hover"; known kinds: challenge, followup, guided/,
    );
    expect(schemaIssues[2]?.message).toMatch(/^steps\[0\]\.request\.url: /);
  });

  it("reports YAML syntax errors and a file without a cases list on their lines", async () => {
    const load = await loadCases(fixture("broken"), CaseSpec);
    const byFile = (file: string) => load.issues.filter((issue) => issue.file === file).map((i) => [i.ruleId, i.line]);

    expect(byFile("cases/auth/syntax.yaml")).toEqual([["schema", 4]]);
    expect(byFile("cases/auth/shape.yaml")).toEqual([
      ["schema", 1],
      ["schema", 1],
    ]);
  });

  it("returns an empty load when the project has no cases folder", async () => {
    const load = await loadCases(fixture("missing"), CaseSpec);

    expect(load).toEqual({ cases: [], retiredIds: new Set(), issues: [] });
  });
});
