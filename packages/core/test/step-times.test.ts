import { rm } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vite-plus/test";
import { z } from "zod";
import { BRAND } from "../src/brand.ts";
import type { StepHandler } from "../src/driver/index.ts";
import { RunValues } from "../src/env/index.ts";
import { definePlugin, PLUGIN_API_VERSION } from "../src/plugin/index.ts";
import { defaultRedactionRules, Redactor } from "../src/redact/index.ts";
import type { CaseResult } from "../src/result/index.ts";
import { runCases } from "../src/run/index.ts";
import { fakeDriver } from "./support/fake-driver.ts";
import { loadTestProject } from "./support/project.ts";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

const steps: StepHandler[] = [
  { kind: "act", schema: z.unknown(), run: async () => {} },
  {
    kind: "wait",
    schema: z.unknown(),
    run: async () => {
      await new Promise((resolve) => setTimeout(resolve, 50));
    },
  },
  {
    kind: "crash",
    schema: z.unknown(),
    run: async () => {
      throw new Error("element gone");
    },
  },
];

async function run(cases: Record<string, unknown>[]): Promise<CaseResult[]> {
  const plugin = definePlugin({
    name: "test-times",
    apiVersion: PLUGIN_API_VERSION,
    drivers: [fakeDriver({ steps })],
  });
  const { root, project, registry } = await loadTestProject(
    {
      [BRAND.configFile]: {
        envs: { demo: { production: false, vars: {}, hosts: ["app.example.test"] } },
        targets: { web: { driver: "fake" } },
      },
      "flows/greet.yaml": { flows: [{ name: "greet", steps: [{ act: 1 }, { act: 2 }] }] },
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
    redactor: new Redactor(defaultRedactionRules()),
    signal: new AbortController().signal,
  });
}

const summary = (result: CaseResult | undefined) =>
  result?.steps.map(({ number, kind, list }) => [number, kind, list]);

describe("step times in a run", () => {
  it("records each top-level step in order with its number, kind, list and times", async () => {
    const [result] = await run([
      {
        id: "SHOP-ONE-001",
        steps: [{ act: 1 }, { wait: 1 }],
        checks: [{ act: 2 }],
        finally: [{ act: 3 }],
      },
    ]);

    expect(summary(result)).toEqual([
      [1, "act", "steps"],
      [2, "wait", "steps"],
      [3, "act", "checks"],
      [4, "act", "finally"],
    ]);
    for (const time of result?.steps ?? []) {
      expect(new Date(time.startedAt).toISOString()).toBe(time.startedAt);
      expect(time.durationMs).toBeGreaterThanOrEqual(0);
    }
  });

  it("numbers the steps of a flow after it expands", async () => {
    const [result] = await run([
      { id: "SHOP-ONE-001", steps: [{ use: "greet" }], checks: [{ act: 9 }] },
    ]);

    expect(summary(result)).toEqual([
      [1, "act", "steps"],
      [2, "act", "steps"],
      [3, "act", "checks"],
    ]);
  });

  it("records a step that throws and none after it", async () => {
    const [result] = await run([
      { id: "SHOP-ONE-001", steps: [{ act: 1 }, { crash: 1 }, { act: 2 }], checks: [{ act: 3 }] },
    ]);

    expect(result?.status).toBe("fail");
    expect(summary(result)).toEqual([
      [1, "act", "steps"],
      [2, "crash", "steps"],
    ]);
  });

  it("leaves out a skipped guided finally step", async () => {
    const [result] = await run([
      {
        id: "SHOP-ONE-001",
        steps: [{ act: 1 }],
        finally: [{ guided: { title: "Look", steps: ["Open it"] } }, { act: 2 }],
      },
    ]);

    expect(summary(result)).toEqual([
      [1, "act", "steps"],
      [3, "act", "finally"],
    ]);
  });

  it("measures the time a step waits", async () => {
    const [result] = await run([{ id: "SHOP-ONE-001", steps: [{ wait: 1 }] }]);

    expect(result?.steps[0]?.durationMs).toBeGreaterThanOrEqual(40);
  });

  it("holds an empty list for a case blocked before its session launched", async () => {
    const [result] = await run([{ id: "SHOP-ONE-001", stage: "retired", steps: [{ act: 1 }] }]);

    expect(result?.status).toBe("blocked");
    expect(result?.steps).toEqual([]);
  });
});
