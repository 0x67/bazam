import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vite-plus/test";
import { z } from "zod";
import { BRAND } from "../src/brand.ts";
import type { StepHandler } from "../src/driver/index.ts";
import { RunValues } from "../src/env/index.ts";
import { definePlugin, PLUGIN_API_VERSION } from "../src/plugin/index.ts";
import { defaultRedactionRules, Redactor } from "../src/redact/index.ts";
import type { CaseResult, CheckRecord } from "../src/result/index.ts";
import { runCases } from "../src/run/index.ts";
import { CaseEvidence } from "../src/run/case-evidence.ts";
import { fakeDriver } from "./support/fake-driver.ts";
import { loadTestProject } from "./support/project.ts";

const roots: string[] = [];
const SECRET = "fake-callout-secret-4471";

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

function check(name: string, extra: Partial<CheckRecord> = {}): CheckRecord {
  return { name, kind: "ui", expected: "yes", observed: "yes", ok: true, ...extra };
}

const steps: StepHandler[] = [
  {
    kind: "expect",
    schema: z.string(),
    run: async (name, ctx) => {
      ctx.evidence.record(check(String(name)));
    },
  },
  {
    kind: "graded",
    schema: z.string(),
    run: async (name, ctx) => {
      ctx.evidence.record(check(String(name), { level: "own" }));
    },
  },
];

async function run(
  cases: Record<string, unknown>[],
  redactor = new Redactor(defaultRedactionRules()),
): Promise<CaseResult[]> {
  const plugin = definePlugin({
    name: "test-marks",
    apiVersion: PLUGIN_API_VERSION,
    drivers: [fakeDriver({ steps })],
  });
  const { root, project, registry } = await loadTestProject(
    {
      [BRAND.configFile]: {
        envs: { demo: { production: false, vars: {}, hosts: ["app.example.test"] } },
        targets: { web: { driver: "fake" } },
      },
      "cases/shop/run.yaml": {
        cases: cases.map((fields) => ({
          title: "a case",
          stage: "acceptance",
          risk: "low",
          links: ["jira:DEMO-7"],
          targets: ["web"],
          ...fields,
        })),
      },
    },
    [plugin],
  );
  roots.push(root);
  return runCases({
    project,
    env: project.config.envs["demo"]!,
    cases: project.cases,
    registry,
    channel: { ask: async () => ({ kind: "verdict", verdict: "pass", note: "" }) },
    runDir: join(root, "runs", "20261107-101500-0a1b"),
    runValues: new RunValues("20261107-101500-0a1b", new Date("2026-11-07T10:15:00Z"), 7),
    seed: 7,
    redactor,
    signal: new AbortController().signal,
  });
}

describe("step marks in a run", () => {
  it("stores the level of a step on its check and leaves the next check bare", async () => {
    const [result] = await run([
      {
        id: "SHOP-ONE-001",
        checks: [{ expect: "core read", level: "core" }, { expect: "after" }],
      },
    ]);

    expect(result?.checks).toEqual([check("core read", { level: "core" }), check("after")]);
  });

  it("stores the level and callout on a check of a step that sets both", async () => {
    const [result] = await run([
      { id: "SHOP-ONE-001", checks: [{ expect: "shown", level: "core", callout: true }] },
    ]);

    expect(result?.checks).toEqual([check("shown", { level: "core", callout: true })]);
  });

  it("gives a follow-up step the level and no callout", async () => {
    const [result] = await run([
      {
        id: "SHOP-ONE-001",
        checks: [
          { followup: { name: "badge", hint: "look" }, level: "source", callout: true },
          { followup: { name: "plain", hint: "look" } },
        ],
      },
    ]);

    expect(result?.checks).toMatchObject([
      { name: "badge", kind: "followup", level: "source" },
      { name: "plain", kind: "followup" },
    ]);
    expect(result?.checks[0]).not.toHaveProperty("callout");
    expect(result?.checks[1]).not.toHaveProperty("level");
    expect(result?.followups).toEqual([
      { item: "badge", hint: "look" },
      { item: "plain", hint: "look" },
    ]);
    expect(result?.status).toBe("followup");
  });

  it("gives the check of a guided step both marks", async () => {
    const [result] = await run([
      {
        id: "SHOP-ONE-001",
        checks: [
          {
            guided: { title: "look at the badge", steps: ["open the page"] },
            level: "manual",
            callout: true,
          },
        ],
      },
    ]);

    expect(result?.checks).toMatchObject([
      { name: "look at the badge", kind: "guided", level: "manual", callout: true },
    ]);
  });

  it("keeps the level a handler sets on its own record", async () => {
    const [result] = await run([
      { id: "SHOP-ONE-001", checks: [{ graded: "own check", level: "core", callout: true }] },
    ]);

    expect(result?.checks).toEqual([check("own check", { level: "own", callout: true })]);
  });

  it("puts a callout note in callouts and not in notes", async () => {
    const [result] = await run([
      {
        id: "SHOP-ONE-001",
        checks: [
          { note: "read this first", callout: true },
          { note: "plain note" },
          { expect: "shown" },
        ],
      },
    ]);

    expect(result?.callouts).toEqual(["read this first"]);
    expect(result?.notes).toEqual(["plain note"]);
  });

  it("writes callouts as an empty list when no note is a callout", async () => {
    const [result] = await run([{ id: "SHOP-ONE-001", checks: [{ expect: "shown" }] }]);

    expect(result?.callouts).toEqual([]);
  });

  it("masks a callout note as it masks the notes", async () => {
    const redactor = new Redactor(defaultRedactionRules());
    redactor.register(SECRET);

    const [result] = await run(
      [
        {
          id: "SHOP-ONE-001",
          checks: [{ note: `token ${SECRET}`, callout: true }, { expect: "x" }],
        },
      ],
      redactor,
    );

    expect(JSON.stringify(result)).not.toContain(SECRET);
    expect(result?.callouts).toHaveLength(1);
  });
});

describe("CaseEvidence.marked", () => {
  async function evidence(): Promise<{ store: CaseEvidence; root: string }> {
    const root = await mkdtemp(join(tmpdir(), "step-marks-"));
    roots.push(root);
    return {
      store: new CaseEvidence(root, "SHOP-ONE-001", new Redactor(defaultRedactionRules())),
      root,
    };
  }

  it("lets a nested step inherit the marks of its holder and override the ones it sets", async () => {
    const { store } = await evidence();

    await store.marked({ level: "core", callout: true }, async () => {
      store.record(check("outer"));
      await store.marked({ level: "inner" }, async () => {
        store.record(check("nested"));
      });
      store.record(check("outer again"));
    });
    store.record(check("after"));

    expect(store.checks).toEqual([
      check("outer", { level: "core", callout: true }),
      check("nested", { level: "inner", callout: true }),
      check("outer again", { level: "core", callout: true }),
      check("after"),
    ]);
  });

  it("restores the outer marks when the step throws", async () => {
    const { store } = await evidence();

    await store
      .marked({ level: "core" }, async () => {
        throw new Error("step failed");
      })
      .catch(() => undefined);
    store.record(check("after"));

    expect(store.checks).toEqual([check("after")]);
  });
});
