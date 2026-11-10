import { existsSync } from "node:fs";
import { mkdir, readdir, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, describe, expect, it } from "vite-plus/test";
import { BRAND } from "@bazam/core/brand";
import { defaultRedactionRules, Redactor } from "@bazam/core/redact";
import type { CaseResult } from "@bazam/core/result";
import type { RunPlan } from "@bazam/core/run";
import { createMcpServer, serveStdio } from "../src/server.ts";
import { RunSupervisor } from "../src/runs.ts";
import {
  CLI_PATH,
  connect,
  DESK_CASES,
  fixtureProject,
  removeFixtures,
  textOf,
  type Connection,
} from "./support/project.ts";

const connections: Connection[] = [];

async function open(root: string, redactor?: Redactor): Promise<Connection> {
  const connection = await connect(root, redactor === undefined ? {} : { redactor });
  connections.push(connection);
  return connection;
}

afterEach(async () => {
  await Promise.all(connections.splice(0).map((connection) => connection.close()));
  await removeFixtures();
});

interface Issue {
  ruleId: string;
  severity: string;
  file: string;
  message: string;
}

interface DraftReport {
  file: string;
  written: boolean;
  issues: Issue[];
  errors: number;
}

const SHELF_CASE = [
  "cases:",
  "  - id: DESK-SHELF-001",
  "    title: The shelf holds the books",
  "    stage: acceptance",
  "    risk: low",
  "    links: [jira:DEMO-2]",
  "    targets: [t]",
  "    checks:",
  '      - api: { request: "GET ${env.API_URL}/shelf", status: 200 }',
  "",
].join("\n");

describe("the server", () => {
  it("lists exactly the twelve tools", async () => {
    const project = await fixtureProject();
    const { client } = await open(project.root);
    const { tools } = await client.listTools();
    expect(tools.map((tool) => tool.name).sort()).toEqual([
      "case_check",
      "case_draft",
      "case_promote",
      "cases_search",
      "evidence_get",
      "prompt_answer",
      "prompt_list",
      "report_ack",
      "report_plan",
      "run_plan",
      "run_start",
      "run_status",
    ]);
    const fields = Object.fromEntries(tools.map((tool) => [tool.name, Object.keys(tool.inputSchema.properties ?? {})]));
    expect(fields).toEqual({
      cases_search: ["text", "filter"],
      case_draft: ["file", "yaml"],
      case_check: ["files"],
      case_promote: ["id", "env"],
      run_plan: ["filter", "env", "roles"],
      run_start: ["filter", "env", "roles", "seed"],
      run_status: ["runId"],
      evidence_get: ["runId", "caseId", "includeImages"],
      prompt_list: ["runId"],
      prompt_answer: ["runId", "promptId", "answer"],
      report_plan: ["runId", "media"],
      report_ack: ["marker", "ticket", "url"],
    });
  });

  it("serves stdio until stdin ends", async () => {
    const project = await fixtureProject();
    const redactor = new Redactor(defaultRedactionRules());
    const server = createMcpServer({
      projectRoot: project.root,
      supervisor: new RunSupervisor(project.root, CLI_PATH),
      redactor,
    });
    const stdin = new PassThrough();
    const stdout = new PassThrough();
    const serving = serveStdio(server, stdin, stdout);
    const initialize = {
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "test-client", version: "0" } },
    };
    stdin.write(`${JSON.stringify(initialize)}\n`);
    const [line] = (await new Promise<Buffer>((done) => stdout.once("data", done))).toString().split("\n");
    const reply = JSON.parse(line!) as { result: { serverInfo: { name: string } } };
    expect(reply.result.serverInfo.name).toBe(BRAND.mcpServerName);
    stdin.end();
    await expect(serving).resolves.toBeUndefined();
  });
});

describe("case tools", () => {
  it("cases_search finds cases in every stage by words and filter", async () => {
    const project = await fixtureProject();
    const mcp = await open(project.root);
    const all = await mcp.json<{ cases: { id: string }[] }>("cases_search", {});
    expect(all.cases.map((c) => c.id)).toEqual(["DESK-LOOK-001", "DESK-OLD-001"]);
    const found = await mcp.json("cases_search", { text: "LAMP old", filter: { domains: ["desk"] } });
    expect(found).toEqual({
      cases: [
        { id: "DESK-OLD-001", title: "The old desk lamp", stage: "retired", links: [], file: "cases/desk/cases.yaml" },
      ],
    });
    const tagged = await mcp.json<{ cases: { id: string }[] }>("cases_search", { filter: { tags: ["visual"] } });
    expect(tagged.cases.map((c) => c.id)).toEqual(["DESK-LOOK-001"]);
  });

  it("masks replies by the redaction in the config as it is at each call, after a start on a config that did not load", async () => {
    const project = await fixtureProject();
    const config = JSON.parse(await project.read(BRAND.configFile)) as Record<string, unknown>;
    await project.write(BRAND.configFile, JSON.stringify({ ...config, typoKey: true }));
    const mcp = await open(project.root);
    const titles = async () =>
      (await mcp.json<{ cases: { title: string }[] }>("cases_search", {})).cases.map((c) => c.title);

    expect((await mcp.call("cases_search", {})).isError).toBe(true);

    await project.write(BRAND.configFile, JSON.stringify({ ...config, redaction: { patterns: ["desk lamp"] } }));

    expect(await titles()).toEqual(["A person looks at the desk", "The old [redacted]"]);

    await project.write(BRAND.configFile, JSON.stringify(config));

    expect(await titles()).toEqual(["A person looks at the desk", "The old desk lamp"]);
  });

  it("case_draft refuses a file with errors", async () => {
    const project = await fixtureProject();
    const mcp = await open(project.root);
    const broken = SHELF_CASE.replace("    title: The shelf holds the books\n", "");
    const report = await mcp.json<DraftReport>("case_draft", { file: "cases/desk/shelf.yaml", yaml: broken });
    expect(report.written).toBe(false);
    expect(report.issues).toContainEqual(
      expect.objectContaining({ ruleId: "schema", severity: "error", file: "cases/desk/shelf.yaml" }),
    );
    expect(existsSync(join(project.root, "cases/desk/shelf.yaml"))).toBe(false);

    // the first file in load order keeps an id, so the duplicate is reported on the file already there
    const duplicate = SHELF_CASE.replace("DESK-SHELF-001", "DESK-LOOK-001");
    const twice = await mcp.json<DraftReport>("case_draft", { file: "cases/desk/a-first.yaml", yaml: duplicate });
    expect(twice.written).toBe(false);
    expect(twice.issues).toContainEqual(
      expect.objectContaining({ ruleId: "id-unique", file: "cases/desk/cases.yaml" }),
    );
    expect(existsSync(join(project.root, "cases/desk/a-first.yaml"))).toBe(false);
  });

  it("case_draft writes a clean file, even next to errors the project already has", async () => {
    const project = await fixtureProject();
    await project.write("cases/attic/cases.yaml", "cases:\n  - id: ATTIC-BOX-001\n");
    const mcp = await open(project.root);
    const report = await mcp.json<DraftReport>("case_draft", {
      file: "cases/shelf/cases.yaml",
      yaml: SHELF_CASE.replaceAll("DESK-", "SHELF-"),
    });
    expect(report).toMatchObject({ file: "cases/shelf/cases.yaml", written: true, errors: 0, issues: [] });
    expect(await project.read("cases/shelf/cases.yaml")).toBe(SHELF_CASE.replaceAll("DESK-", "SHELF-"));
    expect((await readdir(join(project.root, "cases/shelf"))).sort()).toEqual(["cases.yaml"]);
  });

  it("case_draft writes only to cases/<domain>/<name>.yaml in plain folders", async () => {
    const project = await fixtureProject();
    const elsewhere = join(project.root, "elsewhere");
    await mkdir(elsewhere);
    await symlink(elsewhere, join(project.root, "cases", "linked"));
    const mcp = await open(project.root);
    for (const file of [
      "../shelf.yaml",
      "cases/../shelf.yaml",
      "cases/desk/../../shelf.yaml",
      join(project.root, "cases/desk/shelf.yaml"),
      "cases/shelf.yaml",
      "cases/desk/deeper/shelf.yaml",
      "cases/.hidden/shelf.yaml",
      "flows/shelf.yaml",
      "cases/desk/shelf.yml",
      "cases\\desk\\shelf.yaml",
      "cases/linked/shelf.yaml",
    ]) {
      const result = await mcp.call("case_draft", { file, yaml: SHELF_CASE });
      expect(result.isError, file).toBe(true);
    }
    expect(await readdir(elsewhere)).toEqual([]);
    expect((await readdir(join(project.root, "cases/desk"))).sort()).toEqual(["cases.yaml"]);
  });

  it("case_draft checks a copy that holds the runner mapping files inside the root", async () => {
    const project = await fixtureProject();
    const config = JSON.parse(await project.read(BRAND.configFile)) as { targets: Record<string, unknown> };
    const runners = {
      desk: { command: ["node", "desk-suite.js"], results: "out/*.xml", format: "junit", mapping: "interop/desk.yaml" },
    };
    const targets = { ...config.targets, "desk-suite": { runner: "desk" } };
    await project.write(BRAND.configFile, JSON.stringify({ ...config, runners, targets }));
    await project.write("interop/desk.yaml", "tests:\n  shelf holds books: DESK-SHELF-001\n");
    const mcp = await open(project.root);

    // the drafted case runs on no target of runner desk, which only a copy holding the mapping file can see
    const report = await mcp.json<DraftReport>("case_draft", { file: "cases/desk/shelf.yaml", yaml: SHELF_CASE });

    expect(report.written).toBe(false);
    expect(report.issues).toContainEqual(
      expect.objectContaining({
        ruleId: "runner-mapping-valid",
        file: "interop/desk.yaml",
        message: 'test "shelf holds books" maps to case DESK-SHELF-001, which does not run on a target of runner desk',
      }),
    );
    expect(existsSync(join(project.root, "cases/desk/shelf.yaml"))).toBe(false);
  });

  it("case_check reports the issues, only in the files named", async () => {
    const project = await fixtureProject();
    await project.write("cases/attic/cases.yaml", "cases:\n  - id: ATTIC-BOX-001\n");
    const mcp = await open(project.root);
    const all = await mcp.json<{ issues: Issue[]; errors: number }>("case_check", {});
    expect(all.errors).toBeGreaterThan(0);
    expect(new Set(all.issues.map((issue) => issue.file))).toEqual(new Set(["cases/attic/cases.yaml"]));
    const desk = await mcp.json("case_check", { files: ["cases/desk/cases.yaml"] });
    expect(desk).toEqual({ issues: [], errors: 0, warnings: 0 });
  });

  it("run_plan plans the selection and writes nothing; run_plan and run_start refuse an unknown env or no case", async () => {
    const project = await fixtureProject();
    const mcp = await open(project.root);
    const plan = await mcp.json<RunPlan>("run_plan", { env: "demo" });
    expect(plan.env).toBe("demo");
    expect(plan.cases.map((planned) => planned.caseId)).toEqual(["DESK-LOOK-001"]);
    expect(plan.personSteps).toBe(1);
    for (const tool of ["run_plan", "run_start"]) {
      const unknown = await mcp.call(tool, { env: "nowhere" });
      expect(textOf(unknown)).toContain('unknown env "nowhere"; envs: demo');
      const none = await mcp.call(tool, { env: "demo", filter: { ids: ["DESK-NONE-001"] } });
      expect(textOf(none)).toBe("no case matches the selection");
    }
    expect(existsSync(join(project.root, "runs"))).toBe(false);
  });

  it("run_plan binds roles, and run_plan and run_start refuse an unknown role and an identity the role does not list", async () => {
    const project = await fixtureProject();
    const config = JSON.parse(await project.read(BRAND.configFile)) as object;
    const roles = { tester: { identities: ["alice", "bob"], default: "alice" } };
    await project.write(
      BRAND.configFile,
      JSON.stringify({ ...config, identities: { alice: {}, bob: {}, ops: {} }, roles }),
    );
    const mcp = await open(project.root);
    expect((await mcp.json<RunPlan>("run_plan", { env: "demo" })).roles).toEqual({ tester: "alice" });
    expect((await mcp.json<RunPlan>("run_plan", { env: "demo", roles: { tester: "bob" } })).roles).toEqual({
      tester: "bob",
    });
    for (const tool of ["run_plan", "run_start"]) {
      const unknown = await mcp.call(tool, { env: "demo", roles: { guest: "alice" } });
      expect(textOf(unknown)).toBe('unknown role "guest"; roles: tester');
      const unlisted = await mcp.call(tool, { env: "demo", roles: { tester: "ops" } });
      expect(textOf(unlisted)).toBe("role tester lists alice, bob, not ops");
    }
    const proto = await mcp.call("run_plan", { env: "demo", roles: JSON.parse('{"__proto__":"alice"}') as object });
    expect(proto.isError).toBe(true);
    expect(existsSync(join(project.root, "runs"))).toBe(false);
  });

  it("report_plan leaves the adf body out of each comment", async () => {
    const project = await fixtureProject();
    const runId = "20261107-120000-abcd";
    const result: CaseResult = {
      runId,
      caseId: "DESK-LOOK-001",
      title: "A person looks at the desk",
      stage: "acceptance",
      env: "demo",
      target: "t",
      links: ["jira:DEMO-1"],
      status: "pass",
      checks: [{ name: "Look at the desk", kind: "guided", expected: "The desk is tidy", observed: "tidy", ok: true }],
      notes: [],
      followups: [],
      attachments: [],
      challenges: [],
      identities: [],
      seed: 7,
      values: {},
      caseValues: {},
      startedAt: "2026-11-07T12:00:00.000Z",
      finishedAt: "2026-11-07T12:00:05.000Z",
      durationMs: 5000,
    };
    await project.write(`runs/${runId}/DESK-LOOK-001/result.json`, JSON.stringify(result));
    const mcp = await open(project.root);

    const plan = await mcp.json<{ items: { comment: Record<string, unknown> }[] }>("report_plan", { runId });

    expect(plan.items).toHaveLength(1);
    expect(Object.keys(plan.items[0]!.comment).sort()).toEqual(["html", "markdown"]);
  });

  it("report_plan withholds an attachment that holds a fixture value and returns it under withheld", async () => {
    const project = await fixtureProject();
    const runId = "20261107-120000-abcd";
    const pin = "fake-pin-8f3a2c";
    const result = {
      runId,
      caseId: "DESK-LOOK-001",
      title: "A person looks at the desk",
      stage: "acceptance",
      env: "demo",
      target: "t",
      links: ["jira:DEMO-1"],
      status: "pass",
      checks: [],
      notes: [],
      followups: [],
      attachments: ["01-notes.txt", "02-clean.txt"],
      challenges: [],
      identities: [],
      seed: 7,
      values: {},
      caseValues: {},
      startedAt: "2026-11-07T12:00:00.000Z",
      finishedAt: "2026-11-07T12:00:05.000Z",
      durationMs: 5000,
    };
    const caseDir = `runs/${runId}/DESK-LOOK-001`;
    await project.write("fixtures/identities.local.yaml", `alice:\n  pin: ${pin}\n`);
    await project.write(`${caseDir}/result.json`, JSON.stringify(result));
    await project.write(`${caseDir}/01-notes.txt`, `typed ${pin}\n`);
    await project.write(`${caseDir}/02-clean.txt`, "tidy\n");
    const mcp = await open(project.root);

    const plan = await mcp.json<{ items: { attachments: string[]; withheld: unknown }[] }>("report_plan", { runId });

    expect(plan.items[0]?.attachments).toEqual(["DESK-LOOK-001/02-clean.txt"]);
    expect(plan.items[0]?.withheld).toEqual([
      { attachment: "DESK-LOOK-001/01-notes.txt", kinds: ["fixture alice.pin"] },
    ]);
  });

  it("evidence_get returns the result, the attachment paths and, when asked, the screenshots as images", async () => {
    const project = await fixtureProject();
    const runId = "20261107-120000-abcd";
    const caseDir = join(project.root, "runs", runId, "DESK-LOOK-001");
    await mkdir(caseDir, { recursive: true });
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
    await writeFile(join(caseDir, "01-desk.png"), png);
    await writeFile(join(caseDir, "02-notes.txt"), "tidy");
    await writeFile(join(project.root, "escape.png"), png);
    const result = {
      runId,
      caseId: "DESK-LOOK-001",
      attachments: ["01-desk.png", "02-notes.txt", "../../../escape.png"],
    };
    await writeFile(join(caseDir, "result.json"), JSON.stringify(result));
    const mcp = await open(project.root);

    const plain = await mcp.call("evidence_get", { runId, caseId: "DESK-LOOK-001" });
    expect(plain.content).toHaveLength(1);
    expect(JSON.parse(textOf(plain))).toEqual({
      result,
      attachments: [`runs/${runId}/DESK-LOOK-001/01-desk.png`, `runs/${runId}/DESK-LOOK-001/02-notes.txt`],
    });

    const withImages = await mcp.call("evidence_get", { runId, caseId: "DESK-LOOK-001", includeImages: true });
    expect(withImages.content.slice(1)).toEqual([
      { type: "text", text: `runs/${runId}/DESK-LOOK-001/01-desk.png` },
      { type: "image", data: png.toString("base64"), mimeType: "image/png" },
    ]);

    const missing = await mcp.call("evidence_get", { runId, caseId: "DESK-NONE-001" });
    expect(textOf(missing)).toBe(`run ${runId} has no result for DESK-NONE-001`);
    const climbing = await mcp.call("evidence_get", { runId: "..", caseId: "DESK-LOOK-001" });
    expect(climbing.isError).toBe(true);
  });

  it("responses are redacted", async () => {
    const project = await fixtureProject();
    const secret = "fake-secret-0000";
    await project.write(
      "cases/desk/cases.yaml",
      DESK_CASES.replace("The old desk lamp", `The old desk lamp ${secret} on order 123456789`),
    );
    const redactor = new Redactor(defaultRedactionRules());
    redactor.register(secret);
    const mcp = await open(project.root, redactor);

    const found = await mcp.json<{ cases: { title: string }[] }>("cases_search", { text: "lamp" });
    expect(found.cases[0]?.title).toBe("The old desk lamp [redacted] on order ••••6789");

    // an error names the input it refuses, and goes through the redactor too
    const failed = await mcp.call("run_status", { runId: secret });
    expect(failed.isError).toBe(true);
    expect(textOf(failed)).toBe("no run [redacted] has started");

    // a value a person gave is masked in every later response
    const runId = "20261107-120000-abcd";
    await project.write(
      `runs/${runId}/DESK-LOOK-001/result.json`,
      JSON.stringify({ runId, caseId: "DESK-LOOK-001", notes: ["code 4321-9876"], attachments: [] }),
    );
    await project.write(
      `runs/${runId}/prompts/DESK-LOOK-001-1-otp-email.json`,
      JSON.stringify({
        id: "DESK-LOOK-001-1-otp-email",
        runId,
        caseId: "DESK-LOOK-001",
        ask: "value",
        title: "t",
        steps: [],
        timeoutMs: 1000,
      }),
    );
    await mcp.json("prompt_answer", {
      runId,
      promptId: "DESK-LOOK-001-1-otp-email",
      answer: { kind: "value", value: "4321-9876" },
    });
    const evidence = await mcp.json<{ result: { notes: string[] } }>("evidence_get", {
      runId,
      caseId: "DESK-LOOK-001",
    });
    expect(evidence.result.notes).toEqual(["code [redacted]"]);
  });
});
