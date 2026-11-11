import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { beforeEach, describe, expect, it } from "vite-plus/test";
import {
  CaseSpec,
  canPromote,
  loadCases,
  promoteCase,
  retireCase,
  stagePolicy,
  type LoadedCase,
} from "../src/case/index.ts";
import type { CaseResult, Status } from "../src/result/index.ts";

const LOGIN_FILE = `# sign-in journeys
cases:
  - id: AUTH-LOGIN-001
    title: Customer signs in with an email code
    stage: acceptance # promote once DEMO-246 ships
    risk: high
    links: [jira:DEMO-246]
    targets: [web]
    steps:
      - use: { flow: login, with: { email: "\${identity.customer.email}" } }

  # flaky on webkit until DEMO-400
  - id: AUTH-LOGIN-002
    title: Session survives a reload
    stage: regression
    risk: medium
    targets: [web]
  - { id: AUTH-LOGIN-003, title: Signed-out user lands on login, stage: draft, risk: low, targets: [web] }
# more sign-in cases go above this line
`;

let root: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "stage-test-"));
});

async function write(path: string, text: string): Promise<void> {
  await mkdir(dirname(join(root, path)), { recursive: true });
  await writeFile(join(root, path), text);
}

async function loaded(id: string): Promise<LoadedCase> {
  const load = await loadCases(root, CaseSpec);
  const found = load.cases.find((c) => c.spec.id === id);
  if (found === undefined) throw new Error(`${id} did not load: ${JSON.stringify(load.issues)}`);
  return found;
}

function spec(fields: Partial<CaseSpec>): CaseSpec {
  return CaseSpec.parse({
    id: "AUTH-LOGIN-001",
    title: "Customer signs in",
    stage: "acceptance",
    risk: "high",
    targets: ["web"],
    ...fields,
  });
}

function result(runId: string, env: string, status: Status, finishedAt: string): CaseResult {
  return {
    runId,
    caseId: "AUTH-LOGIN-001",
    title: "Customer signs in with an email code",
    stage: "acceptance",
    env,
    target: "web",
    links: ["jira:DEMO-246"],
    status,
    checks: [],
    notes: [],
    followups: [],
    attachments: [],
    challenges: [],
    identities: ["customer"],
    seed: 7,
    values: {},
    caseValues: {},
    startedAt: finishedAt,
    finishedAt,
    durationMs: 0,
  };
}

async function writeResult(r: CaseResult): Promise<void> {
  await write(`runs/${r.runId}/${r.caseId}/result.json`, JSON.stringify(r));
}

describe("stagePolicy", () => {
  it("stage policy table", () => {
    const stages = ["draft", "acceptance", "regression", "retired"] as const;

    expect(Object.fromEntries(stages.map((stage) => [stage, stagePolicy(stage)]))).toEqual({
      draft: { runs: true, postsOn: [] },
      acceptance: { runs: true, postsOn: ["pass", "fail", "blocked", "followup"] },
      regression: { runs: true, postsOn: ["fail", "blocked"] },
      retired: { runs: false, postsOn: [] },
    });
  });
});

describe("canPromote", () => {
  it("refuses a case outside acceptance and a latest result other than pass", () => {
    const pass = result("20261106-093000-a1b2", "demo", "pass", "2026-11-06T09:30:02.000Z");

    expect(canPromote(spec({ stage: "draft" }), pass)).toEqual({
      ok: false,
      reason: expect.stringContaining("draft"),
    });
    expect(canPromote(spec({}), { ...pass, status: "followup" })).toEqual({
      ok: false,
      reason: expect.stringContaining("followup"),
    });
  });
});

describe("promoteCase", () => {
  it("promotes only after a pass in that env", async () => {
    await write("cases/auth/login.yaml", LOGIN_FILE);
    // the uat run directories sort opposite to their finish times, so the newest result has to be picked by time
    await writeResult(result("20261106-090000-0001", "demo", "pass", "2026-11-06T09:00:02.000Z"));
    await writeResult(result("20261105-090000-0002", "demo", "fail", "2026-11-05T09:00:02.000Z"));
    await writeResult(result("20261104-090000-0003", "uat", "pass", "2026-11-04T09:00:02.000Z"));
    await writeResult(result("20261103-090000-0004", "uat", "fail", "2026-11-07T09:00:02.000Z"));
    const target = await loaded("AUTH-LOGIN-001");

    const refused = await promoteCase(root, target, "uat");
    const unchanged = await readFile(join(root, "cases/auth/login.yaml"), "utf8");
    const promoted = await promoteCase(root, target, "demo");
    const after = (await readFile(join(root, "cases/auth/login.yaml"), "utf8")).split("\n");

    expect(refused).toEqual({ ok: false, reason: expect.stringContaining("fail") });
    expect(unchanged).toBe(LOGIN_FILE);
    expect(promoted).toEqual({ ok: true });
    const before = LOGIN_FILE.split("\n");
    expect(after.filter((line, index) => line !== before[index])).toEqual([
      "    stage: regression # promote once DEMO-246 ships",
    ]);
    expect(after).toHaveLength(before.length);
  });

  it("refuses an env with no result for the case and leaves the file alone", async () => {
    await write("cases/auth/login.yaml", LOGIN_FILE);
    const target = await loaded("AUTH-LOGIN-001");

    expect(await promoteCase(root, target, "demo")).toEqual({
      ok: false,
      reason: expect.stringContaining("no result"),
    });
    expect(await readFile(join(root, "cases/auth/login.yaml"), "utf8")).toBe(LOGIN_FILE);
  });

  it("refuses once cases", async () => {
    await write(
      "cases/auth/login.yaml",
      LOGIN_FILE.replace("    risk: high\n", "    risk: high\n    once: true\n"),
    );
    await writeResult(result("20261106-090000-0001", "demo", "pass", "2026-11-06T09:00:02.000Z"));
    const target = await loaded("AUTH-LOGIN-001");

    expect(await promoteCase(root, target, "demo")).toEqual({
      ok: false,
      reason: expect.stringContaining("once"),
    });
    expect(await readFile(join(root, "cases/auth/login.yaml"), "utf8")).toContain(
      "stage: acceptance",
    );
  });
});

describe("retireCase", () => {
  it("retire removes the case and records the id", async () => {
    await write("cases/auth/login.yaml", LOGIN_FILE);
    await write("cases/.retired", "# never reuse these ids\nAUTH-OLD-001");

    await retireCase(root, await loaded("AUTH-LOGIN-002"));

    expect(await readFile(join(root, "cases/auth/login.yaml"), "utf8")).toBe(
      LOGIN_FILE.replace(/ {2}# flaky on webkit[^]*?targets: \[web\]\n/, ""),
    );
    expect(await readFile(join(root, "cases/.retired"), "utf8")).toBe(
      "# never reuse these ids\nAUTH-OLD-001\nAUTH-LOGIN-002\n",
    );
    const load = await loadCases(root, CaseSpec);
    expect(load.issues).toEqual([]);
    expect(load.cases.map((c) => c.spec.id)).toEqual(["AUTH-LOGIN-001", "AUTH-LOGIN-003"]);
  });

  it("keeps comments after the last case when it retires that case", async () => {
    await write("cases/auth/login.yaml", LOGIN_FILE);

    await retireCase(root, await loaded("AUTH-LOGIN-003"));

    const text = await readFile(join(root, "cases/auth/login.yaml"), "utf8");
    expect(text).toBe(LOGIN_FILE.replace(/ {2}- \{ id: AUTH-LOGIN-003.*\n/, ""));
    expect(text).toContain("# more sign-in cases go above this line");
  });

  it("deletes the file when its last case is retired and creates .retired when missing", async () => {
    await write(
      "cases/auth/reload.yaml",
      "cases:\n  - { id: AUTH-RELOAD-001, title: Reload keeps the session, stage: regression, risk: low, targets: [web] }\n",
    );

    await retireCase(root, await loaded("AUTH-RELOAD-001"));

    await expect(readFile(join(root, "cases/auth/reload.yaml"), "utf8")).rejects.toMatchObject({
      code: "ENOENT",
    });
    expect(await readFile(join(root, "cases/.retired"), "utf8")).toBe("AUTH-RELOAD-001\n");
  });
});
