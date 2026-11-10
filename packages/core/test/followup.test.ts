import { join } from "node:path";
import { rm } from "node:fs/promises";
import { afterEach, beforeEach, describe, expect, it } from "vite-plus/test";
import { z } from "zod";
import { BRAND } from "../src/brand.ts";
import type { StepContext, StepHandler } from "../src/driver/index.ts";
import { RunValues } from "../src/env/index.ts";
import { definePlugin, PLUGIN_API_VERSION } from "../src/plugin/index.ts";
import { defaultRedactionRules, Redactor } from "../src/redact/index.ts";
import type { CaseResult } from "../src/result/index.ts";
import { runCases } from "../src/run/index.ts";
import { fakeDriver } from "./support/fake-driver.ts";
import { loadTestProject } from "./support/project.ts";

// what the steps did, in order
let events: string[];
const roots: string[] = [];

beforeEach(() => {
  events = [];
});

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

function step(kind: string, act: (payload: unknown, ctx: StepContext) => Promise<void> = async () => {}): StepHandler {
  return {
    kind,
    schema: z.unknown(),
    run: async (written, ctx) => {
      const payload = await ctx.resolve(written);
      events.push(`${kind} ${JSON.stringify(payload)}`);
      await act(payload, ctx);
    },
  };
}

const steps = [
  step("save", async (payload, ctx) => {
    ctx.values.set(payload as string, "order-17");
  }),
  step("expect", async (payload, ctx) => {
    const ok = payload !== "missing";
    ctx.evidence.record({ name: `${String(payload)} is visible`, kind: "ui", expected: "yes", observed: "no", ok });
  }),
];

async function run(
  cases: Record<string, unknown>[],
  options: { failingLaunches?: number[] } = {},
): Promise<CaseResult[]> {
  const driver = fakeDriver({ steps, ...options });
  const plugin = definePlugin({
    name: "test-followup",
    apiVersion: PLUGIN_API_VERSION,
    drivers: [driver],
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
    channel: { ask: async () => ({ kind: "done" }) },
    runDir: join(root, "runs", "20261107-101500-0a1b"),
    runValues: new RunValues("20261107-101500-0a1b", new Date("2026-11-07T10:15:00Z"), 7),
    seed: 7,
    redactor: new Redactor(defaultRedactionRules()),
    signal: new AbortController().signal,
  });
}

describe("followup steps", () => {
  it("block the case when the hint holds an unresolved placeholder", async () => {
    const [result] = await run([
      { id: "SHOP-ONE-001", checks: [{ followup: { name: "x", hint: "${case.missing}" } }] },
    ]);
    expect(result).toMatchObject({ status: "blocked" });
  });

  it("end a case with no other check as followup, with the name as written and the hint filled", async () => {
    const [result] = await run([
      {
        id: "SHOP-ONE-001",
        steps: [{ save: "order" }],
        checks: [{ followup: { name: "badge for ${case.order}", hint: "open order ${case.order}" } }],
      },
    ]);
    expect(events).toEqual(['save "order"']);
    expect(result).toMatchObject({
      status: "followup",
      followups: [{ item: "badge for ${case.order}", hint: "open order order-17" }],
    });
  });

  it("leave the case failed when an earlier check failed", async () => {
    const [result] = await run([
      {
        id: "SHOP-ONE-001",
        checks: [{ expect: "missing" }, { followup: { name: "badge", hint: "look at it" } }],
      },
    ]);
    expect(result).toMatchObject({ status: "fail", followups: [{ item: "badge", hint: "look at it" }] });
  });
});
