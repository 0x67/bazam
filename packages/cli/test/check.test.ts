import { rm } from "node:fs/promises";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vite-plus/test";
import { BRAND } from "@bazam/core/brand";
import { ExitCode } from "../src/exit.ts";
import { fixtureProject, removeFixtures, startApi, type Api } from "./support/project.ts";

let api: Api;

beforeAll(async () => {
  api = await startApi();
});

afterAll(async () => {
  await api.close();
});

afterEach(removeFixtures);

const UNLINKED_CASE = [
  "cases:",
  "  - id: SHOP-NEW-001",
  "    title: A new shop page",
  "    stage: acceptance",
  "    risk: low",
  "    targets: [t]",
  "    checks:",
  '      - api: { request: "GET ${env.API_URL}/ok", status: 200 }',
  "",
].join("\n");

// a plugin rule that flags every case, written with no imports
const RULE_PLUGIN = `export default {
  name: "house-rules",
  apiVersion: 1,
  checkRules: [{
    id: "house-title",
    check: (project) => project.cases.map(({ spec, source }) => ({
      ruleId: "house-title", severity: "error", file: source.file, line: source.line,
      message: spec.id + " breaks the house rule", fix: "Follow the house rule.",
    })),
  }],
};
`;

describe("check", () => {
  it("exits 0 for a project with no issues", async () => {
    const project = await fixtureProject(api);
    const { code, stdout } = await project.cli("check");
    expect(code).toBe(ExitCode.Pass);
    expect(stdout).toBe("0 errors, 0 warnings\n");
  });

  it("exits 1 and prints file, line, rule id and fix for each issue", async () => {
    const project = await fixtureProject(api);
    await project.write("cases/shop/new.yaml", UNLINKED_CASE);
    const { code, stdout } = await project.cli("check");
    expect(code).toBe(ExitCode.Fail);
    expect(stdout).toBe(
      [
        "cases/shop/new.yaml:2: error stage-link: SHOP-NEW-001 is an acceptance case with no link",
        "  fix: Add the ticket the case covers to links, such as links: [jira:DEMO-246].",
        "1 error, 0 warnings",
        "",
      ].join("\n"),
    );
  });

  it("exits 1 with the config issue when the config file is missing", async () => {
    const project = await fixtureProject(api);
    await rm(join(project.root, BRAND.configFile));
    const { code, stdout } = await project.cli("check", "--json");
    expect(code).toBe(ExitCode.Fail);
    expect(JSON.parse(stdout)).toMatchObject({
      issues: [{ ruleId: "schema", file: BRAND.configFile, line: 1, message: `${BRAND.configFile} is missing` }],
      errors: 1,
    });
  });

  it("counts the rules a plugin adds", async () => {
    const project = await fixtureProject(api);
    await project.write("house-rules.mjs", RULE_PLUGIN);
    const config = JSON.parse(await project.read(BRAND.configFile)) as { plugins: string[] };
    config.plugins.push("./house-rules.mjs");
    await project.write(BRAND.configFile, JSON.stringify(config));
    const { code, stdout } = await project.cli("check", "--json");
    expect(code).toBe(ExitCode.Fail);
    const { issues } = JSON.parse(stdout) as { issues: { ruleId: string }[] };
    expect(issues.map((issue) => issue.ruleId)).toEqual(["house-title", "house-title", "house-title"]);
  });

  it("exits 2 when a plugin does not load", async () => {
    const project = await fixtureProject(api);
    const config = JSON.parse(await project.read(BRAND.configFile)) as { plugins: string[] };
    config.plugins.push("./missing-plugin.mjs");
    await project.write(BRAND.configFile, JSON.stringify(config));
    const { code, stderr } = await project.cli("check");
    expect(code).toBe(ExitCode.CouldNotStart);
    expect(stderr).toContain("missing-plugin.mjs");
  });
});

/** Every property name anywhere in a JSON Schema. */
function propertyNames(schema: unknown): Set<string> {
  const names = new Set<string>();
  const visit = (node: unknown): void => {
    if (Array.isArray(node)) return node.forEach(visit);
    if (typeof node !== "object" || node === null) return;
    const { properties } = node as { properties?: Record<string, unknown> };
    for (const name of Object.keys(properties ?? {})) names.add(name);
    Object.values(node).forEach(visit);
  };
  visit(schema);
  return names;
}

describe("schema", () => {
  it("prints the case file schema with the step kinds of the default plugins", async () => {
    const project = await fixtureProject(api);
    const { code, stdout } = await project.cli("schema", "--json");
    expect(code).toBe(ExitCode.Pass);
    const names = propertyNames(JSON.parse(stdout));
    for (const kind of ["cases", "request", "api", "challenge", "guided", "open", "tap", "fill"]) {
      expect(names).toContain(kind);
    }
    // an integer's bounds are long digit runs that a full mask would turn into text
    expect(stdout).toContain("9007199254740991");
  });

  it("exits 2 without a config, since the plugins come from it", async () => {
    const project = await fixtureProject(api);
    await rm(join(project.root, BRAND.configFile));
    const { code, stderr } = await project.cli("schema");
    expect(code).toBe(ExitCode.CouldNotStart);
    expect(stderr).toContain(`${BRAND.configFile}:1: error schema: ${BRAND.configFile} is missing`);
  });
});
