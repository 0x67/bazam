import { afterAll, afterEach, beforeAll, describe, expect, it } from "vite-plus/test";
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

const PIN = "fake-pin-8f3a2c";

async function ranProject(): Promise<Fixture> {
  const project = await fixtureProject(api);
  await project.write("fixtures/identities.local.yaml", `alice:\n  pin: ${PIN}\n`);
  const { code } = await project.cli(
    "run",
    "--env",
    "demo",
    "--case",
    "SHOP-OK-001",
    "--run",
    "r1",
  );
  expect(code).toBe(ExitCode.Pass);
  return project;
}

describe("scan", () => {
  it("exits 0 on a run folder with no finding", async () => {
    const project = await ranProject();

    const { code, stdout, stderr } = await project.cli("scan", "--run", "r1");

    expect(code, stderr).toBe(ExitCode.Pass);
    expect(stdout).toMatch(/\d+ files, 0 findings/);
  });

  it("exits 1 with one line per file and kind, and prints no value", async () => {
    const project = await ranProject();
    await project.write("runs/r1/SHOP-OK-001/leak.txt", `sent ${PIN} and again ${PIN}\n`);

    const { code, stdout } = await project.cli("scan", "--run", "r1");

    expect(code).toBe(ExitCode.Fail);
    expect(stdout).toContain("SHOP-OK-001/leak.txt: fixture alice.pin x2:");
    expect(stdout).toContain("[fixture alice.pin]");
    expect(stdout).not.toContain(PIN);
  });

  it("prints the report with --json", async () => {
    const project = await ranProject();
    await project.write("runs/r1/SHOP-OK-001/leak.txt", `sent ${PIN}\n`);

    const { code, stdout } = await project.cli("scan", "--run", "r1", "--json");

    expect(code).toBe(ExitCode.Fail);
    const report = JSON.parse(stdout) as { findings: { kind: string; file: string }[] };
    expect(report.findings).toEqual([
      expect.objectContaining({ kind: "fixture alice.pin", file: "SHOP-OK-001/leak.txt" }),
    ]);
  });

  it("exits 2 for an unknown run, a missing --run and a folder with no results", async () => {
    const project = await ranProject();
    await project.write("runs/bare/notes.txt", "nothing\n");

    expect((await project.cli("scan", "--run", "nope")).code).toBe(ExitCode.CouldNotStart);
    expect((await project.cli("scan")).code).toBe(ExitCode.CouldNotStart);
    expect((await project.cli("scan", "--run", "bare")).code).toBe(ExitCode.CouldNotStart);
  });
});
