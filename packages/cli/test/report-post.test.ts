import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vite-plus/test";
import { BRAND } from "@bazam/core/brand";
import { bugLabel } from "@bazam/core/report";
import { startJiraStub, type JiraStub } from "../../tracker-jira/test/support/jira-stub.ts";
import { ExitCode } from "../src/exit.ts";
import { fixtureProject, removeFixtures, startApi, type Api, type Fixture } from "./support/project.ts";

const EMAIL = "qa@example.test";
const TOKEN = "not-a-real-jira-token";

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
      {
        key: "DEMO-12",
        status: "In Review",
        transitions: [
          { id: "21", name: "In Progress", to: "In Progress" },
          { id: "31", name: "Ready for Release", to: "Ready for Release" },
        ],
      },
    ],
  });
});

afterEach(async () => {
  await stub.close();
  await removeFixtures();
});

function shopCase(id: string, stage: string, links: string[], path: string, title: string): string[] {
  return [
    `  - id: ${id}`,
    `    title: ${title}`,
    `    stage: ${stage}`,
    "    risk: low",
    ...(links.length === 0 ? [] : [`    links: [${links.join(", ")}]`]),
    "    targets: [t]",
    "    checks:",
    `      - api: { request: "GET \${env.API_URL}/${path}", status: 200 }`,
  ];
}

/** An acceptance case that passes, regression cases that fail, pass, and fail with no bug project. */
function shopCases(options: { okLinks?: string[]; failPath?: string } = {}): string {
  const { okLinks = ["jira:DEMO-12"], failPath = "broken" } = options;
  return [
    "cases:",
    ...shopCase("SHOP-OK-001", "acceptance", okLinks, "ok", "The shop answers"),
    ...shopCase("SHOP-FAIL-001", "regression", ["jira:DEMO-12"], failPath, "The shop reports an error"),
    ...shopCase("SHOP-BACK-001", "regression", ["jira:DEMO-12"], "ok", "The shop is back"),
    ...shopCase("SHOP-LOOSE-001", "regression", [], "broken", "The shop fails where no one tracks it"),
    "",
  ].join("\n");
}

/** The fixture project with a Jira tracker on the stub; without `site` when `site` is false. */
async function trackedProject(options: { site?: boolean; secrets?: boolean } = {}): Promise<Fixture> {
  const project = await fixtureProject(api);
  const config = JSON.parse(await project.read(BRAND.configFile)) as Record<string, unknown>;
  const jira = {
    ...(options.site === false ? {} : { site: stub.site }),
    secrets: { email: "DEMO_JIRA_EMAIL", token: "DEMO_JIRA_TOKEN" },
    projects: {
      DEMO: {
        transitions: { pass: "Ready for Release", fail: "In Progress" },
        bugs: { issueType: "Bug", labels: ["regression"], onPass: "Done" },
      },
    },
  };
  await project.write(BRAND.configFile, JSON.stringify({ ...config, trackers: { jira } }));
  if (options.secrets !== false) {
    await project.write(`${BRAND.stateDir}/secrets.env`, `DEMO_JIRA_EMAIL=${EMAIL}\nDEMO_JIRA_TOKEN=${TOKEN}\n`);
  }
  await project.write("cases/shop/cases.yaml", shopCases());
  return project;
}

async function run(project: Fixture, runId: string, ...argv: string[]): Promise<void> {
  const { stderr } = await project.cli("run", "--env", "demo", "--run", runId, ...argv);
  expect(stderr).toContain(`run ${runId}:`);
}

function lines(text: string): string[] {
  return text.trimEnd().split("\n");
}

describe("report post", () => {
  it("posts each item, files a bug for a failing regression case, then comments on it, and exits 0", async () => {
    const project = await trackedProject();
    const browse = `http://${stub.site}/browse`;
    await run(project, "r1");
    const first = await project.cli("report", "post", "--run", "r1");
    expect(first.code, first.stderr).toBe(ExitCode.Pass);
    const posted = lines(first.stdout);
    // items first, then bug outcomes
    expect(posted.slice(0, 2)).toEqual(
      Array(2).fill(expect.stringMatching(new RegExp(`^posted DEMO-12 ${browse}/DEMO-12\\?focusedCommentId=\\d+$`))),
    );
    expect(posted.slice(2).sort()).toEqual(
      ["SHOP-BACK-001: no open bug in DEMO", `SHOP-FAIL-001: filed DEMO-13 ${browse}/DEMO-13`].sort(),
    );
    expect(first.stderr).toContain("no bug project for SHOP-LOOSE-001");
    expect(first.stdout + first.stderr).not.toContain(TOKEN);
    expect(stub.issues.get("DEMO-13")).toMatchObject({
      summary: "[SHOP-FAIL-001] The shop reports an error fails in demo",
      labels: ["regression", bugLabel("SHOP-FAIL-001")],
    });
    expect(stub.links).toEqual([{ type: "Relates", inward: "DEMO-13", outward: "DEMO-12" }]);

    await run(project, "r2", "--case", "SHOP-FAIL-001");
    const second = await project.cli("report", "post", "--run", "r2", "--json");
    expect(second.code, second.stderr).toBe(ExitCode.Pass);
    const doc = JSON.parse(second.stdout) as { runId: string; items: { ok: boolean }[]; bugs: unknown[] };
    expect(doc.runId).toBe("r2");
    expect(doc.items).toMatchObject([{ ok: true, ticket: { tracker: "jira", key: "DEMO-12" } }]);
    expect(doc.bugs).toEqual([
      {
        caseId: "SHOP-FAIL-001",
        ok: true,
        action: "commented on DEMO-13",
        key: "DEMO-13",
        url: expect.stringMatching(new RegExp(`^${browse}/DEMO-13\\?focusedCommentId=\\d+$`)),
      },
    ]);

    // the case passes now, so its open bug gets a comment and moves to onPass
    await project.write("cases/shop/cases.yaml", shopCases({ failPath: "ok" }));
    stub.issues.get("DEMO-13")!.transitions = [{ id: "41", name: "Done", to: "Done", category: "done" }];
    await run(project, "r3", "--case", "SHOP-FAIL-001");
    const third = await project.cli("report", "post", "--run", "r3");
    expect(third.code, third.stderr).toBe(ExitCode.Pass);
    expect(lines(third.stdout)).toEqual([
      expect.stringMatching(
        new RegExp(
          `^SHOP-FAIL-001: commented on DEMO-13 and moved it to Done ${browse}/DEMO-13\\?focusedCommentId=\\d+$`,
        ),
      ),
    ]);
    expect(stub.issues.get("DEMO-13")?.status).toBe("Done");
  });

  it("exits 1 when an item fails, and sends nothing for a project the config does not list", async () => {
    const project = await trackedProject();
    await project.write("cases/shop/cases.yaml", shopCases({ okLinks: ["jira:DEMO-12", "jira:OTHER-3"] }));
    await run(project, "r1", "--case", "SHOP-OK-001");
    const { code, stdout } = await project.cli("report", "post", "--run", "r1");
    expect(code).toBe(ExitCode.Fail);
    expect(lines(stdout)).toEqual([
      expect.stringMatching(/^posted DEMO-12 /),
      "failed OTHER-3: project OTHER is not listed under trackers.jira.projects",
    ]);
    expect(stub.requests.filter((request) => request.path.includes("OTHER"))).toEqual([]);
  });

  it("exits 1 when a bug action fails, and masks its error by the configured patterns", async () => {
    const project = await trackedProject();
    const config = JSON.parse(await project.read(BRAND.configFile)) as Record<string, unknown>;
    await project.write(BRAND.configFile, JSON.stringify({ ...config, redaction: { patterns: ["offers none"] } }));
    const labels = [bugLabel("SHOP-BACK-001")];
    stub.issues.set("DEMO-13", { key: "DEMO-13", status: "Open", labels, transitions: [] });
    await run(project, "r1", "--case", "SHOP-BACK-001");
    const error = "transition Done is not available on DEMO-13; it [redacted]";
    const text = await project.cli("report", "post", "--run", "r1");
    expect(text.code, text.stderr).toBe(ExitCode.Fail);
    expect(lines(text.stdout)).toEqual([`failed SHOP-BACK-001: commented on DEMO-13: ${error}`]);
    const json = await project.cli("report", "post", "--run", "r1", "--json");
    expect(json.code, json.stderr).toBe(ExitCode.Fail);
    const doc = JSON.parse(json.stdout) as { items: unknown[]; bugs: unknown[] };
    expect(doc.items).toEqual([]);
    expect(doc.bugs).toMatchObject([
      { caseId: "SHOP-BACK-001", ok: false, action: "commented on DEMO-13", key: "DEMO-13", error },
    ]);
  });

  it("prints what it would send with --dry-run, reading no secret and sending nothing", async () => {
    const project = await trackedProject({ secrets: false });
    await run(project, "r1");
    const text = await project.cli("report", "post", "--run", "r1", "--dry-run");
    expect(text.code, text.stderr).toBe(ExitCode.Pass);
    const items = [
      "jira:DEMO-12 read the ticket",
      "jira:DEMO-12 post the pass comment for SHOP-OK-001",
      "jira:DEMO-12 move to Ready for Release",
      "jira:DEMO-12 read the ticket",
      "jira:DEMO-12 post the fail comment for SHOP-FAIL-001",
      "jira:DEMO-12 move to In Progress",
    ];
    const bugs = [
      `jira:DEMO SHOP-FAIL-001: comment on the open bug labelled ${bugLabel("SHOP-FAIL-001")}, or file "[SHOP-FAIL-001] The shop reports an error fails in demo"`,
      `jira:DEMO SHOP-BACK-001: comment on the open bug labelled ${bugLabel("SHOP-BACK-001")} and move it to Done`,
    ];
    expect(lines(text.stdout)).toEqual([...items, ...bugs]);
    const json = await project.cli("report", "post", "--run", "r1", "--dry-run", "--json");
    expect(JSON.parse(json.stdout)).toEqual({ runId: "r1", dryRun: true, items, bugs });
    expect(stub.requests).toEqual([]);
  });

  it("exits 2 without --run, and for a tracker with no site, in a dry run too", async () => {
    const project = await trackedProject({ site: false });
    await run(project, "r1");
    const runs = [
      await project.cli("report", "post"),
      await project.cli("report", "post", "--run", "r1"),
      await project.cli("report", "post", "--run", "r1", "--dry-run"),
    ];
    expect(runs.map((result) => result.code)).toEqual(Array(3).fill(ExitCode.CouldNotStart));
    expect(runs.map((result) => result.stderr.split("\n")[0])).toEqual([
      "error: --run is required: name the run to report",
      "error: cannot post to jira: trackers.jira.site is not set",
      "error: cannot post to jira: trackers.jira.site is not set",
    ]);
    expect(stub.requests).toEqual([]);
  });
});
