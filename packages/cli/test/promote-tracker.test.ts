import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vite-plus/test";
import { BRAND } from "@bazam/core/brand";
import { startJiraStub, type JiraStub } from "../../tracker-jira/test/support/jira-stub.ts";
import { ExitCode } from "../src/exit.ts";
import { fixtureProject, removeFixtures, startApi, type Api, type Fixture } from "./support/project.ts";

const EMAIL = "qa@example.test";
const TOKEN = "not-a-real-jira-token";
const CASES_FILE = "cases/shop/cases.yaml";

let api: Api;
let stub: JiraStub;

beforeAll(async () => {
  api = await startApi();
});

afterAll(async () => {
  await api.close();
});

beforeEach(async () => {
  stub = await startJiraStub({
    email: EMAIL,
    token: TOKEN,
    issues: [
      { key: "DEMO-12", status: "Done", category: "done" },
      { key: "DEMO-14", status: "In Review", category: "indeterminate" },
      { key: "DEMO-15", status: "Released", category: "done" },
    ],
  });
});

afterEach(async () => {
  await stub.close();
  await removeFixtures();
});

/** Acceptance cases in each state promotion meets, and one regression case it leaves alone. */
function shopCases(readyStage = "acceptance"): string {
  const shopCase = (id: string, stage: string, links: string[], path = "ok"): string[] => [
    `  - id: ${id}`,
    `    title: Case ${id}`,
    `    stage: ${stage}`,
    "    risk: low",
    ...(links.length === 0 ? [] : [`    links: [${links.join(", ")}]`]),
    "    targets: [t]",
    "    checks:",
    `      - api: { request: "GET \${env.API_URL}/${path}", status: 200 }`,
  ];
  return [
    "cases:",
    ...shopCase("SHOP-READY-001", readyStage, ["jira:DEMO-12"]),
    ...shopCase("SHOP-WAIT-001", "acceptance", ["jira:DEMO-12", "jira:DEMO-14"]),
    ...shopCase("SHOP-RED-001", "acceptance", ["jira:DEMO-15"], "broken"),
    ...shopCase("SHOP-GONE-001", "acceptance", ["jira:DEMO-99"]),
    ...shopCase("SHOP-AWAY-001", "acceptance", ["jira:OTHER-3", "jira:DEMO-12"]),
    ...shopCase("SHOP-ALONE-001", "acceptance", []),
    ...shopCase("SHOP-OLD-001", "regression", ["jira:DEMO-12"]),
    "",
  ].join("\n");
}

async function trackedProject(options: { site?: boolean } = {}): Promise<Fixture> {
  const project = await fixtureProject(api);
  const config = JSON.parse(await project.read(BRAND.configFile)) as Record<string, unknown>;
  const jira = {
    ...(options.site === false ? {} : { site: stub.site }),
    secrets: { email: "DEMO_JIRA_EMAIL", token: "DEMO_JIRA_TOKEN" },
    projects: { DEMO: { promoteOn: ["Done", "Released"] } },
  };
  await project.write(BRAND.configFile, JSON.stringify({ ...config, trackers: { jira } }));
  await project.write(`${BRAND.stateDir}/secrets.env`, `DEMO_JIRA_EMAIL=${EMAIL}\nDEMO_JIRA_TOKEN=${TOKEN}\n`);
  await project.write(CASES_FILE, shopCases());
  return project;
}

describe("promote --from-tracker", () => {
  it("promotes only ready cases with a passing result, editing only their stage lines", async () => {
    const project = await trackedProject();
    expect((await project.cli("run", "--env", "demo", "--run", "r1")).code).toBe(ExitCode.Fail);
    const { code, stdout, stderr } = await project.cli("promote", "--from-tracker", "--env", "demo", "--json");
    expect(code, stderr).toBe(ExitCode.Pass);
    expect(JSON.parse(stdout)).toEqual({
      promoted: ["SHOP-READY-001"],
      stayed: [
        { caseId: "SHOP-WAIT-001", reason: "DEMO-14 is In Review; promoteOn lists Done, Released" },
        { caseId: "SHOP-RED-001", reason: "the latest result of SHOP-RED-001 in demo is fail, from run r1" },
        { caseId: "SHOP-GONE-001", reason: expect.stringContaining("/rest/api/3/issue/DEMO-99 answered 404") },
        { caseId: "SHOP-AWAY-001", reason: "project OTHER is not listed under trackers.jira.projects" },
        { caseId: "SHOP-ALONE-001", reason: "no linked tickets" },
      ],
    });
    expect(await project.read(CASES_FILE)).toBe(shopCases("regression"));
    // reads only, and never a ticket of a project the config does not list
    expect(stub.requests.every((request) => request.method === "GET")).toBe(true);
    expect(stub.requests.filter((request) => request.path.includes("OTHER"))).toEqual([]);
  });

  it("prints one line per selected acceptance case, and keeps every case of a tracker with no site", async () => {
    const project = await trackedProject({ site: false });
    const { code, stdout } = await project.cli(
      "promote",
      "--from-tracker",
      "--env",
      "demo",
      "--case",
      "SHOP-READY-001",
      "--case",
      "SHOP-ALONE-001",
      "--case",
      "SHOP-OLD-001",
    );
    expect(code).toBe(ExitCode.Pass);
    expect(stdout).toBe(
      "SHOP-READY-001 stays: trackers.jira.site is not set\nSHOP-ALONE-001 stays: no linked tickets\n",
    );
    expect(await project.read(CASES_FILE)).toBe(shopCases());
    expect(stub.requests).toEqual([]);
  });

  it("exits 2 without --env, for an unknown env and for a case id given as an argument", async () => {
    const project = await trackedProject();
    const runs = [
      await project.cli("promote", "--from-tracker"),
      await project.cli("promote", "--from-tracker", "--env", "nope"),
      await project.cli("promote", "SHOP-READY-001", "--from-tracker", "--env", "demo"),
    ];
    expect(runs.map((run) => run.code)).toEqual(Array(3).fill(ExitCode.CouldNotStart));
    expect(runs.map((run) => run.stderr.split("\n")[0])).toEqual([
      "error: --env is required: promote looks at the latest result in that env",
      'error: unknown env "nope"',
      "error: promote --from-tracker takes selection flags, such as --case <id>, not a case id",
    ]);
  });
});
