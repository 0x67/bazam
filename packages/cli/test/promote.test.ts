import { existsSync } from "node:fs";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vite-plus/test";
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

const CASES_FILE = "cases/shop/cases.yaml";

describe("promote", () => {
  it("moves a case that passed in the env to regression, changing only its stage line", async () => {
    const project = await fixtureProject(api);
    expect((await project.cli("run", "--env", "demo", "--case", "SHOP-OK-001")).code).toBe(ExitCode.Pass);
    const before = await project.read(CASES_FILE);
    const { code, stdout } = await project.cli("promote", "SHOP-OK-001", "--env", "demo", "--json");
    expect(code).toBe(ExitCode.Pass);
    expect(JSON.parse(stdout)).toEqual({ caseId: "SHOP-OK-001", ok: true });
    expect(await project.read(CASES_FILE)).toBe(before.replace("stage: acceptance", "stage: regression"));
  });

  it("exits 1 for a case with no pass in the env, and leaves the file as it was", async () => {
    const project = await fixtureProject(api);
    const before = await project.read(CASES_FILE);
    const { code, stdout } = await project.cli("promote", "SHOP-OK-001", "--env", "demo");
    expect(code).toBe(ExitCode.Fail);
    expect(stdout).toBe("not promoted: SHOP-OK-001 has no result in this environment; run it there first\n");
    expect(await project.read(CASES_FILE)).toBe(before);
  });

  it("exits 2 without --env, for an unknown env and for a case that is not loaded", async () => {
    const project = await fixtureProject(api);
    const runs = [
      await project.cli("promote", "SHOP-OK-001"),
      await project.cli("promote", "SHOP-OK-001", "--env", "nope"),
      await project.cli("promote", "SHOP-NONE-001", "--env", "demo"),
      await project.cli("promote", "--env", "demo"),
    ];
    expect(runs.map((run) => run.code)).toEqual(Array(4).fill(ExitCode.CouldNotStart));
    expect(runs[2]?.stderr).toContain("no case SHOP-NONE-001 loaded");
  });
});

describe("retire", () => {
  it("removes the case from its file and records its id, which check then accepts", async () => {
    const project = await fixtureProject(api);
    const { code, stdout } = await project.cli("retire", "SHOP-DOWN-001");
    expect(code).toBe(ExitCode.Pass);
    expect(stdout).toBe("retired SHOP-DOWN-001\n");
    const cases = await project.read(CASES_FILE);
    expect(cases).not.toContain("SHOP-DOWN-001");
    expect(cases).toContain("SHOP-FAIL-001");
    expect(await project.read("cases/.retired")).toBe("SHOP-DOWN-001\n");
    expect((await project.cli("check")).code).toBe(ExitCode.Pass);
  });

  it("deletes the file when its last case is retired", async () => {
    const project = await fixtureProject(api);
    for (const id of ["SHOP-OK-001", "SHOP-FAIL-001", "SHOP-DOWN-001"]) {
      expect((await project.cli("retire", id)).code).toBe(ExitCode.Pass);
    }
    expect(existsSync(join(project.root, CASES_FILE))).toBe(false);
    expect(await project.read("cases/.retired")).toBe("SHOP-OK-001\nSHOP-FAIL-001\nSHOP-DOWN-001\n");
  });
});
