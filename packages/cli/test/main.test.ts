import { spawn, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vite-plus/test";
import { BRAND } from "@bazam/core/brand";
import { ExitCode, exitCodeFor } from "../src/exit.ts";
import { cli, fixtureProject, removeFixtures, startApi, type Api } from "./support/project.ts";

let api: Api;

beforeAll(async () => {
  api = await startApi();
});

afterAll(async () => {
  await api.close();
});

afterEach(removeFixtures);

const BIN = fileURLToPath(new URL("../src/main.ts", import.meta.url));

/** Two web cases; the first keeps its page open long enough for a Ctrl-C to reach it. */
const WAIT_CASES = [
  "cases:",
  "  - id: DESK-WAIT-001",
  "    title: The desk page stays open",
  "    stage: acceptance",
  "    risk: low",
  "    targets: [w]",
  "    steps:",
  '      - open: "${env.API_URL}/ok"',
  "      - wait: { ms: 60000 }",
  "  - id: DESK-LATER-001",
  "    title: A later desk case",
  "    stage: acceptance",
  "    risk: low",
  "    targets: [w]",
  "    steps:",
  '      - open: "${env.API_URL}/ok"',
  "",
].join("\n");

/** A case whose blocked reason in the plan names an identity with a long digit run. */
const GHOST_CASE = [
  "cases:",
  "  - id: DESK-GHOST-001",
  "    title: An identity config does not define reads the desk",
  "    stage: regression",
  "    risk: low",
  "    targets: [t]",
  "    checks:",
  '      - api: { request: "GET ${env.API_URL}/ok", as: ghost12345678, status: 200 }',
  "",
].join("\n");

const DESK_TOKEN = "not-a-real-desk-token";
const PLUGIN_SECRET = "not-a-real-plugin-secret";

/** A process plugin that offers nothing; it writes its pid and a line with an inherited secret, and ends with stdin. */
const QUIET_PLUGIN = `import { writeFileSync } from "node:fs";
import { createInterface } from "node:readline";
writeFileSync(process.env.QUIET_PID_FILE, String(process.pid));
process.stderr.write("started with " + process.env.DEMO_PLUGIN_SECRET + "\\n");
createInterface({ input: process.stdin }).on("line", (line) => {
  const { id, method } = JSON.parse(line);
  const answer = (result) => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id, result }) + "\\n");
  if (method === "initialize") answer({ protocolVersion: 1, name: "quiet", apiVersion: 1, contributions: {} });
  if (method === "shutdown") answer(null);
});
`;

function running(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** The first title holds a value the second case only later reads as a secret. */
const TOKEN_CASES = [
  "cases:",
  "  - id: DESK-TITLE-001",
  `    title: The desk shows ${DESK_TOKEN}`,
  "    stage: regression",
  "    risk: low",
  "    targets: [t]",
  "    checks:",
  '      - api: { request: "GET ${env.API_URL}/ok", status: 200 }',
  "  - id: DESK-TOKEN-001",
  "    title: The desk takes its token",
  "    stage: regression",
  "    risk: low",
  "    targets: [t]",
  "    steps:",
  '      - request: { method: GET, url: "${env.API_URL}/ok", headers: { x-desk-token: "${secret.DESK_TOKEN}" } }',
  "    checks:",
  '      - api: { request: "GET ${env.API_URL}/ok", status: 200 }',
  "",
].join("\n");

describe("exitCodeFor", () => {
  it("gives 1 for any fail, else 3 for any blocked or followup, else 0", () => {
    expect(exitCodeFor(["pass", "blocked", "fail"])).toBe(ExitCode.Fail);
    expect(exitCodeFor(["pass", "blocked"])).toBe(ExitCode.Incomplete);
    expect(exitCodeFor(["followup", "pass"])).toBe(ExitCode.Incomplete);
    expect(exitCodeFor(["pass", "pass"])).toBe(ExitCode.Pass);
    expect(exitCodeFor([])).toBe(ExitCode.Pass);
  });
});

describe("main", () => {
  it("--json prints one document", async () => {
    const project = await fixtureProject(api);
    const runs = [
      await project.cli("run", "--env", "demo", "--json"),
      await project.cli("plan", "--env", "demo", "--json"),
      await project.cli("check", "--json"),
      await project.cli("schema", "--json"),
      await project.cli("run", "--env", "nope", "--json"),
      await project.cli("run", "--no-such-flag", "--json"),
    ];
    for (const { stdout } of runs) expect(() => JSON.parse(stdout)).not.toThrow();
    const [run, plan, check, , unknownEnv, unknownFlag] = runs.map(
      ({ stdout }) => JSON.parse(stdout) as unknown,
    );
    expect(run).toMatchObject({
      counts: { pass: 1, fail: 1, blocked: 1, followup: 0, total: 3 },
      cases: [
        { caseId: "SHOP-OK-001", status: "pass" },
        { caseId: "SHOP-FAIL-001", status: "fail" },
        { caseId: "SHOP-DOWN-001", status: "blocked" },
      ],
    });
    expect(plan).toMatchObject({ env: "demo", personSteps: 0 });
    expect(check).toEqual({ issues: [], errors: 0, warnings: 0 });
    expect(unknownEnv).toEqual({ error: 'unknown env "nope"; envs: demo' });
    expect(unknownFlag).toMatchObject({ error: expect.stringContaining("--no-such-flag") });
    // logs go to stderr, never into the document
    expect(runs[0]?.stderr).toContain("3 cases on env demo");
  });

  it("exits 0, 1, 2 and 3 for the fixture runs", async () => {
    const project = await fixtureProject(api);
    const codes = {
      pass: await project.cli("run", "--env", "demo", "--case", "SHOP-OK-001"),
      fail: await project.cli(
        "run",
        "--env",
        "demo",
        "--case",
        "SHOP-FAIL-001",
        "--case",
        "SHOP-DOWN-001",
      ),
      blocked: await project.cli(
        "run",
        "--env",
        "demo",
        "--case",
        "SHOP-DOWN-001",
        "--case",
        "SHOP-OK-001",
      ),
      unknownEnv: await project.cli("run", "--env", "nope"),
    };
    expect(
      Object.fromEntries(Object.entries(codes).map(([name, run]) => [name, run.code])),
    ).toEqual({
      pass: 0,
      fail: 1,
      blocked: 3,
      unknownEnv: 2,
    });
    expect(codes.blocked.stdout).toContain("SHOP-DOWN-001 on t:");
    expect(codes.unknownEnv.stderr).toContain('error: unknown env "nope"; envs: demo');
  });

  it("exits 2 when a case's target names a driver no plugin registered", async () => {
    const project = await fixtureProject(api);
    const config = JSON.parse(await project.read(BRAND.configFile)) as {
      targets: Record<string, unknown>;
    };
    config.targets["t"] = { driver: "missing" };
    await project.write(BRAND.configFile, JSON.stringify(config));
    const { code, stderr } = await project.cli("run", "--env", "demo", "--case", "SHOP-OK-001");
    expect(code).toBe(ExitCode.CouldNotStart);
    expect(stderr).toContain('unknown driver "missing"');
  });

  it("exits 2 and prints file:line issues when a case file does not load at run start", async () => {
    const project = await fixtureProject(api);
    await project.write(
      "cases/shop/broken.yaml",
      "cases:\n  - id: SHOP-BAD-001\n    title: No stage\n",
    );
    const { code, stderr } = await project.cli("run", "--env", "demo");
    expect(code).toBe(ExitCode.CouldNotStart);
    expect(stderr).toContain("cases/shop/broken.yaml:2: error schema:");
  });

  it("exits 2 for no command, an unknown command and an unknown flag, and 0 for --help", async () => {
    const project = await fixtureProject(api);
    const none = await cli([], project.root);
    expect(none.code).toBe(ExitCode.CouldNotStart);
    expect(none.stderr).toContain(`Usage: ${BRAND.name} <command>`);
    expect((await project.cli("launch")).stderr).toContain('unknown command "launch"');
    expect((await project.cli("run", "--colour")).code).toBe(ExitCode.CouldNotStart);
    const help = await project.cli("--help");
    expect(help.code).toBe(ExitCode.Pass);
    for (const usage of [
      "report plan --run <id>",
      "report post --run <id> [--media <file>] [--dry-run] [--json]",
      "[--run <id>] [--workers <n>] [--as <role>=<identity>] [--dry-run]",
      "promote --from-tracker --env <env> [selection]",
      "ingest --env <env> --target <target> [selection] [--run <id>] <files...>",
    ]) {
      expect(help.stdout).toContain(usage);
    }
  });

  it("ends process plugins after the command and masks their stderr", async () => {
    const project = await fixtureProject(api);
    const config = JSON.parse(await project.read(BRAND.configFile)) as { plugins: unknown[] };
    const pidFile = join(project.root, "quiet.pid");
    const quiet = {
      command: [process.execPath, join(project.root, "quiet.mjs")],
      env: { QUIET_PID_FILE: pidFile },
    };
    await project.write("quiet.mjs", QUIET_PLUGIN);
    await project.write(
      BRAND.configFile,
      JSON.stringify({
        ...config,
        plugins: [...config.plugins, quiet],
        secrets: { names: ["DEMO_PLUGIN_SECRET"] },
      }),
    );
    process.env["DEMO_PLUGIN_SECRET"] = PLUGIN_SECRET;
    let pid = 0;
    try {
      const { code, stderr } = await project.cli("plan", "--env", "demo");
      pid = Number(await project.read("quiet.pid"));
      expect(code, stderr).toBe(ExitCode.Pass);
      expect(running(pid)).toBe(false);
      expect(stderr).toContain("started with ");
      expect(stderr).not.toContain(PLUGIN_SECRET);
    } finally {
      delete process.env["DEMO_PLUGIN_SECRET"];
      if (pid > 0 && running(pid)) process.kill(pid, "SIGKILL");
    }
  });

  it("masks long digit runs in what it prints", async () => {
    const project = await fixtureProject(api);
    const { stderr } = await project.cli("run", "--env", "demo", "--suite", "nightly-12345678");
    expect(stderr).toContain('unknown suite "nightly-••••5678"');
    await project.write("cases/desk/ghost.yaml", GHOST_CASE);
    for (const json of [[], ["--json"]]) {
      const plan = await project.cli("plan", "--env", "demo", "--domain", "desk", ...json);
      expect(plan.stdout, plan.stderr).toContain("ghost••••5678");
      expect(plan.stdout).not.toContain("12345678");
    }
  });

  it("masks on stdout a secret the run reads after an earlier case finished", async () => {
    const project = await fixtureProject(api);
    const config = JSON.parse(await project.read(BRAND.configFile)) as Record<string, unknown>;
    await project.write(
      BRAND.configFile,
      JSON.stringify({ ...config, secrets: { names: ["DESK_TOKEN"] } }),
    );
    await project.write(`${BRAND.stateDir}/secrets.env`, `DESK_TOKEN=${DESK_TOKEN}\n`);
    await project.write("cases/desk/cases.yaml", TOKEN_CASES);
    for (const json of [[], ["--json"]]) {
      const { code, stdout, stderr } = await project.cli(
        "run",
        "--env",
        "demo",
        "--domain",
        "desk",
        ...json,
      );
      expect(code, stderr).toBe(ExitCode.Pass);
      expect(stdout).toContain("DESK-TITLE-001");
      expect(stdout).not.toContain(DESK_TOKEN);
    }
  });

  it("ends a web run cancelled on the first Ctrl-C, with exit 3 and one JSON document", async () => {
    const project = await fixtureProject(api);
    const config = JSON.parse(await project.read(BRAND.configFile)) as {
      targets: Record<string, unknown>;
    };
    config.targets["w"] = { driver: "playwright" };
    await project.write(BRAND.configFile, JSON.stringify(config));
    await project.write("cases/desk/cases.yaml", WAIT_CASES);
    const before = api.requests.length;
    const argv = [
      "run",
      "--env",
      "demo",
      "--domain",
      "desk",
      "--json",
      "--run",
      "stop",
      "--root",
      project.root,
    ];
    const child = spawn(process.execPath, ["--conditions=development", BIN, ...argv], {
      stdio: "pipe",
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8").on("data", (text: string) => (stdout += text));
    child.stderr.setEncoding("utf8").on("data", (text: string) => (stderr += text));
    const exited = new Promise<number | null>((done) => child.on("exit", done));
    // the browser has the page open once the api sees its request
    await vi.waitFor(() => expect(api.requests.length).toBeGreaterThan(before), {
      timeout: 30_000,
      interval: 50,
    });
    child.kill("SIGINT");
    expect(await exited, stderr).toBe(ExitCode.Incomplete);
    expect(JSON.parse(stdout)).toMatchObject({
      counts: { blocked: 2, total: 2 },
      cases: [
        { caseId: "DESK-WAIT-001", reason: "run cancelled" },
        { caseId: "DESK-LATER-001", reason: "run cancelled" },
      ],
    });
    expect(JSON.parse(await project.read("runs/stop/status.json"))).toMatchObject({
      state: "finished",
    });
    expect(existsSync(join(project.root, "runs", "stop", "post-plan.json"))).toBe(true);
  }, 60_000);

  it("runs as a bin and sets the process exit code", () => {
    const run = (...args: string[]) =>
      spawnSync(process.execPath, ["--conditions=development", BIN, ...args], { encoding: "utf8" });
    const help = run("--help");
    expect(help.status).toBe(ExitCode.Pass);
    expect(help.stdout).toContain(`Usage: ${BRAND.name}`);
    expect(run("launch").status).toBe(ExitCode.CouldNotStart);
  });
});
