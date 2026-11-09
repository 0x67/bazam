import { afterAll, afterEach, beforeAll, describe, expect, it } from "vite-plus/test";
import { BRAND } from "@bazam/core/brand";
import type { PostPlan } from "@bazam/core/report";
import { ExitCode } from "../src/exit.ts";
import { fixtureProject, removeFixtures, startApi, type Api, type Fixture } from "./support/project.ts";

let api: Api;

beforeAll(async () => {
  api = await startApi();
});

afterAll(async () => {
  await api.close();
});

afterEach(removeFixtures);

const MARKER = `${BRAND.markerPrefix}:SHOP-OK-001:r1`;
// a comment id is a long digit run, which the redactor's digit rule would mask
const COMMENT_URL = "https://tracker.example.test/browse/DEMO-1?focusedCommentId=10234567";

async function ranProject(): Promise<Fixture> {
  const project = await fixtureProject(api);
  const { code } = await project.cli("run", "--env", "demo", "--case", "SHOP-OK-001", "--run", "r1");
  expect(code).toBe(ExitCode.Pass);
  return project;
}

async function reportPlan(project: Fixture, ...argv: string[]): Promise<PostPlan> {
  const { code, stdout, stderr } = await project.cli("report", "plan", "--run", "r1", "--json", ...argv);
  expect(code, stderr).toBe(ExitCode.Pass);
  return JSON.parse(stdout) as PostPlan;
}

function edits(plan: PostPlan): [string, string | undefined][] {
  return plan.items.map((item) => [item.ticket.key, item.edit?.url]);
}

describe("report", () => {
  it("records an ack, so the next plan for that case and ticket edits the comment", async () => {
    const project = await ranProject();
    const first = await reportPlan(project);
    expect(first.items.map((item) => item.marker)).toEqual([MARKER, MARKER]);
    // the Jira tracker from the default plugins renders the comment as HTML too
    expect(first.items.map((item) => item.comment.html?.startsWith("<p><strong>"))).toEqual([true, true]);
    expect(edits(first)).toEqual([
      ["DEMO-1", undefined],
      ["DEMO-2", undefined],
    ]);
    const ack = await project.cli("report", "ack", MARKER, "--ticket", "jira:DEMO-1", "--url", COMMENT_URL, "--json");
    expect(ack.code, ack.stderr).toBe(ExitCode.Pass);
    expect(JSON.parse(ack.stdout)).toEqual({ marker: MARKER, ticket: "jira:DEMO-1", caseId: "SHOP-OK-001" });
    expect(edits(await reportPlan(project))).toEqual([
      ["DEMO-1", COMMENT_URL],
      ["DEMO-2", undefined],
    ]);
    // post-plan.json stays as the run wrote it; the next run's plan carries the edit
    const written = JSON.parse(await project.read("runs/r1/post-plan.json")) as PostPlan;
    expect(edits(written)).toEqual([
      ["DEMO-1", undefined],
      ["DEMO-2", undefined],
    ]);
    await project.cli("run", "--env", "demo", "--case", "SHOP-OK-001", "--run", "r2");
    expect(edits(JSON.parse(await project.read("runs/r2/post-plan.json")) as PostPlan)).toEqual([
      ["DEMO-1", COMMENT_URL],
      ["DEMO-2", undefined],
    ]);
  });

  it("refuses an ack when several items share the marker and --ticket is missing", async () => {
    const project = await ranProject();
    const { code, stderr } = await project.cli("report", "ack", MARKER, "--url", COMMENT_URL);
    expect(code).toBe(ExitCode.CouldNotStart);
    expect(stderr).toContain(`several items share ${MARKER}; pass --ticket with one of jira:DEMO-1, jira:DEMO-2`);
    expect(edits(await reportPlan(project))).toEqual([
      ["DEMO-1", undefined],
      ["DEMO-2", undefined],
    ]);
  });

  it("refuses an ack without a URL, with a marker that is not one and for an item the run lacks", async () => {
    const project = await ranProject();
    const runs = [
      await project.cli("report", "ack", MARKER, "--ticket", "jira:DEMO-1"),
      await project.cli("report", "ack", "SHOP-OK-001", "--url", COMMENT_URL),
      await project.cli("report", "ack", `${BRAND.markerPrefix}:SHOP-OK-001:../r1`, "--url", COMMENT_URL),
      await project.cli("report", "ack", MARKER, "--ticket", "jira:DEMO-9", "--url", COMMENT_URL),
    ];
    expect(runs.map((run) => run.code)).toEqual(Array(4).fill(ExitCode.CouldNotStart));
    expect(runs.map((run) => run.stderr.split("\n")[0])).toEqual([
      "error: --url is required: the URL of the posted comment",
      `error: "SHOP-OK-001" is not a marker; one looks like ${BRAND.markerPrefix}:<case-id>:<run-id>`,
      'error: run id "../r1" is not a plain file name',
      `error: run r1 has no item ${MARKER} for jira:DEMO-9`,
    ]);
  });

  it("takes media references from a file and refuses a file that holds none", async () => {
    const project = await ranProject();
    await project.write("media.json", JSON.stringify({ "SHOP-OK-001/01-screen.png": { id: "media-1" } }));
    expect((await reportPlan(project, "--media", `${project.root}/media.json`)).items).toHaveLength(2);
    await project.write("bad-media.json", JSON.stringify({ "SHOP-OK-001/01-screen.png": { id: "" } }));
    const bad = await project.cli("report", "plan", "--run", "r1", "--media", `${project.root}/bad-media.json`);
    expect(bad.code).toBe(ExitCode.CouldNotStart);
    expect(bad.stderr).toContain("SHOP-OK-001/01-screen.png.id:");
  });

  it("exits 2 without --run, for a run that does not exist and for an unknown action", async () => {
    const project = await fixtureProject(api);
    const runs = [
      await project.cli("report", "plan"),
      await project.cli("report", "plan", "--run", "nope"),
      await project.cli("report", "send"),
    ];
    expect(runs.map((run) => run.code)).toEqual(Array(3).fill(ExitCode.CouldNotStart));
    expect(runs.map((run) => run.stderr.split("\n")[0])).toEqual([
      "error: --run is required: name the run to report",
      expect.stringContaining("error: cannot read the run folder"),
      'error: report takes plan, post or ack, not "send"',
    ]);
  });
});
