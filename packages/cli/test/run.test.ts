import { existsSync } from "node:fs";
import { mkdir, readdir, readFile, symlink, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vite-plus/test";
import { BRAND } from "@bazam/core/brand";
import type { RunPlan } from "@bazam/core/run";
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

const DESK_CASES = [
  "cases:",
  "  - id: DESK-GHOST-001",
  "    title: An identity config does not define reads the desk",
  "    stage: regression",
  "    risk: low",
  "    targets: [t]",
  "    checks:",
  '      - api: { request: "GET ${env.API_URL}/ok", as: ghost, status: 200 }',
  "  - id: DESK-OLD-001",
  "    title: The old desk",
  "    stage: retired",
  "    risk: low",
  "    targets: [t]",
  "    checks:",
  '      - api: { request: "GET ${env.API_URL}/ok", status: 200 }',
  "  - id: DESK-PHONE-001",
  "    title: The desk on the other target",
  "    stage: regression",
  "    risk: low",
  "    targets: [u]",
  "    checks:",
  '      - api: { request: "GET ${env.API_URL}/ok", status: 200 }',
  "",
].join("\n");

const GUIDED_CASE = [
  "cases:",
  "  - id: DESK-LOOK-001",
  "    title: A person looks at the desk",
  "    stage: regression",
  "    risk: low",
  "    targets: [t]",
  "    steps:",
  "      - guided:",
  "          title: Look at the desk",
  "          steps: [Open the desk page]",
  "          expected: The desk is tidy",
  "",
].join("\n");

/** A web case whose code arrives by mail, which the otp-mailpit resolver from the default plugins reads. */
const CODE_CASE = [
  "cases:",
  "  - id: DESK-CODE-001",
  "    title: The desk mails a sign-in code",
  "    stage: regression",
  "    risk: low",
  "    targets: [w]",
  "    steps:",
  "      - challenge:",
  "          kind: otp-email",
  "          trigger: { tap: { id: send-code } }",
  "          fill: { id: code }",
  "",
].join("\n");

async function planOf(project: Fixture, ...argv: string[]): Promise<RunPlan> {
  const { code, stdout, stderr } = await project.cli("plan", "--env", "demo", "--json", ...argv);
  expect(code, stderr).toBe(ExitCode.Pass);
  return JSON.parse(stdout) as RunPlan;
}

describe("plan", () => {
  it("lists the cases with their blocked reasons and runs no step", async () => {
    const project = await fixtureProject(api);
    await project.write("cases/desk/cases.yaml", DESK_CASES);
    const before = api.requests.length;
    const plan = await planOf(project, "--case", "SHOP-OK-001", "--case", "DESK-GHOST-001");
    expect(plan.cases.map(({ caseId, target, blocked }) => ({ caseId, target, blocked }))).toEqual([
      { caseId: "DESK-GHOST-001", target: "t", blocked: expect.stringContaining("ghost") },
      { caseId: "SHOP-OK-001", target: "t", blocked: undefined },
    ]);
    expect(api.requests.length).toBe(before);
    expect(existsSync(join(project.root, "runs"))).toBe(false);
    const text = await project.cli("plan", "--env", "demo", "--case", "DESK-GHOST-001");
    expect(text.stdout).toContain("DESK-GHOST-001 on t: blocked:");
  });

  it("run --dry-run prints the plan", async () => {
    const project = await fixtureProject(api);
    const { code, stdout } = await project.cli("run", "--env", "demo", "--dry-run", "--json");
    expect(code).toBe(ExitCode.Pass);
    expect((JSON.parse(stdout) as RunPlan).cases).toHaveLength(3);
    expect(existsSync(join(project.root, "runs"))).toBe(false);
  });

  it("keeps the stages a suite names when flags narrow it", async () => {
    const project = await fixtureProject(api);
    await project.write("cases/desk/cases.yaml", DESK_CASES);
    await project.write("suites.yaml", "old:\n  stages: [retired, regression]\n");
    const plan = await planOf(project, "--suite", "old", "--domain", "desk", "--target", "t");
    expect(plan.cases.map((planned) => [planned.caseId, planned.stage])).toEqual([
      ["DESK-GHOST-001", "regression"],
      ["DESK-OLD-001", "retired"],
    ]);
  });

  it("lets --stage pick a stage that a suite naming no stages leaves out", async () => {
    const project = await fixtureProject(api);
    await project.write("cases/desk/cases.yaml", DESK_CASES);
    await project.write("suites.yaml", "desk:\n  domains: [desk]\n");
    const plan = await planOf(project, "--suite", "desk", "--stage", "retired");
    expect(plan.cases.map((planned) => [planned.caseId, planned.stage])).toEqual([["DESK-OLD-001", "retired"]]);
    const bySuite = await planOf(project, "--suite", "desk");
    expect(bySuite.cases.map((planned) => planned.caseId)).toEqual(["DESK-GHOST-001", "DESK-PHONE-001"]);
  });

  it("plans a challenge with a resolver from the default plugins", async () => {
    const project = await fixtureProject(api);
    const config = JSON.parse(await project.read(BRAND.configFile)) as {
      envs: Record<string, Record<string, unknown>>;
      targets: Record<string, unknown>;
    };
    config.envs["demo"] = { ...config.envs["demo"], challenges: { "otp-email": ["otp-mailpit"] } };
    config.targets["w"] = { driver: "playwright" };
    await project.write(BRAND.configFile, JSON.stringify(config));
    await project.write("cases/desk/code.yaml", CODE_CASE);
    const plan = await planOf(project, "--domain", "desk");
    expect(plan.cases.map(({ caseId, challenges }) => ({ caseId, challenges }))).toEqual([
      { caseId: "DESK-CODE-001", challenges: [{ step: 1, kind: "otp-email", resolver: "otp-mailpit" }] },
    ]);
  });

  it("leaves out a case none of whose targets --target keeps", async () => {
    const project = await fixtureProject(api);
    await project.write("cases/desk/cases.yaml", DESK_CASES);
    const plan = await planOf(project, "--domain", "desk", "--target", "u");
    expect(plan.cases.map((planned) => [planned.caseId, planned.target, planned.blocked])).toEqual([
      ["DESK-PHONE-001", "u", undefined],
    ]);
  });

  it("exits 2 for an unknown suite, stage or channel, a bad seed, a missing env and an empty selection", async () => {
    const project = await fixtureProject(api);
    const errors = await Promise.all(
      [
        ["--suite", "nope"],
        ["--stage", "done"],
        ["--channel", "pager"],
        ["--seed", "1.5"],
        ["--case", "SHOP-NONE-001"],
      ].map(async (argv) => project.cli("plan", "--env", "demo", ...argv)),
    );
    errors.push(await project.cli("plan"));
    expect(errors.map((run) => run.code)).toEqual(Array(6).fill(ExitCode.CouldNotStart));
    expect(errors.map((run) => run.stderr.split("\n")[0])).toEqual([
      'error: unknown suite "nope"; suites: none',
      'error: unknown stage "done"; stages: draft, acceptance, regression, retired',
      expect.stringContaining('error: unknown human channel "pager"'),
      'error: --seed takes a whole number, not "1.5"',
      "error: no case matches the selection",
      "error: --env is required; envs: demo",
    ]);
  });
});

describe("run", () => {
  it("copies each answer file named for a prompt id, and nothing else, before the run", async () => {
    const project = await fixtureProject(api);
    await project.write("cases/desk/look.yaml", GUIDED_CASE);
    const answers = join(project.root, "fixtures", "answers");
    await mkdir(join(answers, "old.json"), { recursive: true });
    const verdict = (note: string) => JSON.stringify({ kind: "verdict", verdict: "pass", note });
    await writeFile(join(answers, "DESK-LOOK-001-1-guided.json"), verdict("tidy"));
    await writeFile(join(answers, "EXTRA-1-guided.json"), verdict("unused"));
    await writeFile(join(answers, "bad name.json"), verdict("bad name"));
    await writeFile(join(answers, "notes.txt"), "not an answer");
    await writeFile(join(project.root, "elsewhere.json"), verdict("linked"));
    await symlink(join(project.root, "elsewhere.json"), join(answers, "link.json"));
    const { code, stderr } = await project.cli(
      "run",
      "--env",
      "demo",
      "--case",
      "DESK-LOOK-001",
      "--channel",
      "answers-file",
      "--answers",
      // relative to the folder the CLI runs in, as --root is
      join(basename(project.root), "fixtures", "answers"),
      "--run",
      "answers-run",
    );
    expect(code, stderr).toBe(ExitCode.Pass);
    // the run claimed and deleted the answer it used
    expect(await readdir(join(project.root, "runs", "answers-run", "answers"))).toEqual(["EXTRA-1-guided.json"]);
    for (const name of ["bad name.json", "link.json", "old.json"]) expect(stderr).toContain(`skipped ${name}`);
    const result = JSON.parse(
      await readFile(join(project.root, "runs", "answers-run", "DESK-LOOK-001", "result.json"), "utf8"),
    ) as { status: string; checks: { ok: boolean }[] };
    expect(result).toMatchObject({ status: "pass", checks: [{ ok: true }] });
  });

  it("refuses --answers without the answers-file channel, and a missing answers folder, in a dry run too", async () => {
    const project = await fixtureProject(api);
    for (const dryRun of [[], ["--dry-run"]]) {
      const terminal = await project.cli("run", "--env", "demo", "--answers", "fixtures/answers", ...dryRun);
      expect(terminal.code).toBe(ExitCode.CouldNotStart);
      expect(terminal.stderr).toContain("--answers works only with --channel answers-file");
      const missing = await project.cli(
        "run",
        "--env",
        "demo",
        "--channel",
        "answers-file",
        "--answers",
        "no-such-folder",
        ...dryRun,
      );
      expect(missing.code).toBe(ExitCode.CouldNotStart);
      expect(missing.stderr).toContain("cannot read the answers folder");
    }
    expect(existsSync(join(project.root, "runs"))).toBe(false);
  });

  it("refuses a --run id that is not a plain name or whose run has started", async () => {
    const project = await fixtureProject(api);
    const escape = await project.cli("run", "--env", "demo", "--run", "../outside");
    expect(escape.code).toBe(ExitCode.CouldNotStart);
    expect(escape.stderr).toContain('run id "../outside" is not a plain file name');
    // a caller that picks the id may put its own files in the folder first
    await project.write("runs/picked/supervisor.json", "{}");
    const first = await project.cli("run", "--env", "demo", "--case", "SHOP-OK-001", "--run", "picked");
    expect(first.code).toBe(ExitCode.Pass);
    const again = await project.cli("run", "--env", "demo", "--case", "SHOP-OK-001", "--run", "picked");
    expect(again.code).toBe(ExitCode.CouldNotStart);
    expect(again.stderr).toContain("run picked has already started");
  });

  it("records the seed it was given in each result", async () => {
    const project = await fixtureProject(api);
    const { stderr } = await project.cli(
      "run",
      "--env",
      "demo",
      "--case",
      "SHOP-OK-001",
      "--seed",
      "4242",
      "--run",
      "s",
    );
    expect(stderr).toContain("seed 4242");
    const result = JSON.parse(await project.read("runs/s/SHOP-OK-001/result.json")) as { seed: number };
    expect(result.seed).toBe(4242);
  });
});
