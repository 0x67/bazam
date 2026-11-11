import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vite-plus/test";
import { BRAND } from "@bazam/core/brand";
import { ExitCode } from "../src/exit.ts";
import { cli } from "./support/project.ts";

const START = `<!-- ${BRAND.markerPrefix}:start -->`;
const END = `<!-- ${BRAND.markerPrefix}:end -->`;
const IGNORED = ["runs/", `${BRAND.stateDir}/`, "fixtures/identities.local.yaml"];

let root: string;

beforeEach(async () => {
  // outside any git repository, so check reads the project's own .gitignore
  root = await mkdtemp(join(tmpdir(), "cli-init-"));
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

const read = (path: string): Promise<string> => readFile(join(root, path), "utf8");

describe("init", () => {
  it("creates the layout", async () => {
    const init = await cli(["init", "--json"], root);
    expect(init.code).toBe(ExitCode.Pass);
    const created = [
      BRAND.configFile,
      "cases/.gitkeep",
      "flows/.gitkeep",
      "suites.yaml",
      "people.yaml",
      "fixtures/identities.example.yaml",
      ".gitignore",
      "AGENTS.md",
    ];
    expect(JSON.parse(init.stdout)).toEqual({ created, updated: [], kept: [] });
    expect((await readdir(root)).sort()).toEqual(
      [
        ".gitignore",
        "AGENTS.md",
        BRAND.configFile,
        "cases",
        "fixtures",
        "flows",
        "people.yaml",
        "suites.yaml",
      ].sort(),
    );
    expect(await read(".gitignore")).toBe(`${IGNORED.join("\n")}\n`);
    const agents = await read("AGENTS.md");
    expect(agents.startsWith(`${START}\n`)).toBe(true);
    expect(agents.endsWith(`${END}\n`)).toBe(true);
    expect(agents).toContain(BRAND.skillName);
    for (const command of [
      "check",
      "run --env",
      "exec --env <env> -- <command>",
      "ingest --env",
      "keepalive --env",
      "logout --as",
      "report post --run",
    ]) {
      expect(agents).toContain(`${BRAND.name} ${command}`);
    }
    expect(agents).toContain("`report_plan`");
    // every starter file parses and the project passes its own check
    const check = await cli(["check"], root);
    expect(check.stdout).toBe("0 errors, 0 warnings\n");
    expect(check.code).toBe(ExitCode.Pass);
  });

  it("rerun keeps user files and replaces only the marked AGENTS.md section", async () => {
    await cli(["init"], root);
    const config = `${await read(BRAND.configFile)}# edited by the team\n`;
    await writeFile(join(root, BRAND.configFile), config);
    await writeFile(join(root, "suites.yaml"), "smoke:\n  stages: [acceptance]\n");
    await writeFile(join(root, ".gitignore"), "node_modules/\n/runs\n");
    const section = (await read("AGENTS.md")).trimEnd();
    await writeFile(
      join(root, "AGENTS.md"),
      `# Team notes\n\n${START}\nstale text\n${END}\n\nKeep this line.\n`,
    );

    const rerun = await cli(["init", "--json"], root);
    expect(rerun.code).toBe(ExitCode.Pass);
    expect(JSON.parse(rerun.stdout)).toEqual({
      created: [],
      updated: [".gitignore", "AGENTS.md"],
      kept: [
        BRAND.configFile,
        "cases/.gitkeep",
        "flows/.gitkeep",
        "suites.yaml",
        "people.yaml",
        "fixtures/identities.example.yaml",
      ],
    });
    expect(await read(BRAND.configFile)).toBe(config);
    expect(await read("suites.yaml")).toBe("smoke:\n  stages: [acceptance]\n");
    // "/runs" already ignores the runs folder, so only the missing lines are added
    expect(await read(".gitignore")).toBe(`node_modules/\n/runs\n${IGNORED.slice(1).join("\n")}\n`);
    expect(await read("AGENTS.md")).toBe(`# Team notes\n\n${section}\n\nKeep this line.\n`);

    const third = await cli(["init", "--json"], root);
    expect(JSON.parse(third.stdout)).toMatchObject({ created: [], updated: [] });
  });

  it("appends the section to an AGENTS.md without markers and refuses one with a single marker", async () => {
    await writeFile(join(root, "AGENTS.md"), "# Team notes");
    expect((await cli(["init"], root)).code).toBe(ExitCode.Pass);
    const agents = await read("AGENTS.md");
    expect(agents.startsWith(`# Team notes\n\n${START}\n`)).toBe(true);
    expect(agents.endsWith(`${END}\n`)).toBe(true);

    await writeFile(join(root, "AGENTS.md"), `${START}\nhalf a section\n`);
    const refused = await cli(["init"], root);
    expect(refused.code).toBe(ExitCode.CouldNotStart);
    expect(refused.stderr).toContain("or neither");
    expect(await read("AGENTS.md")).toBe(`${START}\nhalf a section\n`);
  });
});
