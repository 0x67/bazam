import { join } from "node:path";
import { rm } from "node:fs/promises";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { z } from "zod";
import { BRAND } from "../src/brand.ts";
import { CaseBlocked } from "../src/run/outcome.ts";
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
let cancel: AbortController;
const roots: string[] = [];

beforeEach(() => {
  events = [];
  cancel = new AbortController();
});

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

function step(
  kind: string,
  act: (payload: unknown, ctx: StepContext) => Promise<void> = async () => {},
): StepHandler {
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
  step("log"),
  step("cancel", async () => cancel.abort()),
  step("crash", async () => {
    throw new Error("element gone");
  }),
  step("block", async () => {
    throw new CaseBlocked("test data is gone");
  }),
  step("note-followup", async (_payload, ctx) =>
    ctx.evidence.followup("check the ledger", "ask finance"),
  ),
  step("expect", async (payload, ctx) => {
    const ok = payload !== "missing";
    ctx.evidence.record({
      name: `${String(payload)} is visible`,
      kind: "ui",
      expected: "yes",
      observed: "no",
      ok,
    });
  }),
  step("hang", async (_payload, ctx) => {
    await new Promise((_, reject) =>
      ctx.signal.addEventListener("abort", () => reject(ctx.signal.reason)),
    );
  }),
  step("signal-state", async (_payload, ctx) => {
    events.push(`finally signal aborted: ${ctx.signal.aborted}`);
  }),
];

async function run(
  cases: Record<string, unknown>[],
  options: { failingLaunches?: number[] } = {},
): Promise<CaseResult[]> {
  const driver = fakeDriver({ steps, ...options });
  const plugin = definePlugin({
    name: "test-finally",
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
    signal: cancel.signal,
  });
}

describe("finally steps", () => {
  it("store neither the level nor the callout of a finally step", async () => {
    const [result] = await run([
      {
        id: "SHOP-ONE-001",
        checks: [{ expect: "cart" }],
        finally: [
          { expect: "gone", level: "core", callout: true },
          { note: "bye", callout: true },
        ],
      },
    ]);

    expect(result?.callouts).toEqual([]);
    expect(result?.notes).toEqual(["finally check gone is visible: ok", "bye"]);
  });

  it("run after a pass with the values the steps saved, and add no check", async () => {
    const [result] = await run([
      {
        id: "SHOP-ONE-001",
        steps: [{ save: "order" }],
        checks: [{ expect: "cart" }],
        finally: [{ log: "${case.order}" }],
      },
    ]);
    expect(events).toEqual(['save "order"', 'expect "cart"', 'log "order-17"']);
    expect(result).toMatchObject({ status: "pass", notes: [] });
    expect(result?.checks).toHaveLength(1);
  });

  it.each([
    ["a failed check", { checks: [{ expect: "missing" }] }, { status: "fail" }],
    ["a failed step", { steps: [{ crash: {} }] }, { status: "fail" }],
  ])("run after %s and leave its status alone", async (_name, fields, expected) => {
    const [result] = await run([{ id: "SHOP-ONE-001", ...fields, finally: [{ log: "cleanup" }] }]);
    expect(events.at(-1)).toBe('log "cleanup"');
    expect(result).toMatchObject(expected);
  });

  it("run under a signal of their own after the run is cancelled", async () => {
    const [result] = await run([
      {
        id: "SHOP-ONE-001",
        steps: [{ cancel: {} }, { log: "never" }],
        finally: [{ "signal-state": {} }],
      },
    ]);
    expect(events).toEqual(["cancel {}", "signal-state {}", "finally signal aborted: false"]);
    expect(result).toMatchObject({ status: "blocked", reason: "run cancelled" });
  });

  it("turn a failing step and a failing check into notes and go on to the next step", async () => {
    const [result] = await run([
      {
        id: "SHOP-ONE-001",
        checks: [{ expect: "cart" }],
        finally: [{ crash: {} }, { expect: "missing" }, { expect: "gone" }, { log: "last" }],
      },
    ]);
    expect(events.at(-1)).toBe('log "last"');
    expect(result).toMatchObject({ status: "pass" });
    expect(result?.checks.map((check) => check.name)).toEqual(["cart is visible"]);
    expect(result?.notes).toEqual([
      "finally step 2 (crash) failed: element gone",
      "finally check missing is visible: not ok",
      "finally check gone is visible: ok",
    ]);
  });

  it("run after a blocked step and leave the case blocked with its reason", async () => {
    const [result] = await run([
      {
        id: "SHOP-ONE-001",
        steps: [{ block: {} }, { log: "never" }],
        finally: [{ log: "cleanup" }],
      },
    ]);
    expect(events).toEqual(["block {}", 'log "cleanup"']);
    expect(result).toMatchObject({ status: "blocked", reason: "test data is gone" });
  });

  it("keep a followup recorded in a finally step from turning the case into followup", async () => {
    const [result] = await run([
      { id: "SHOP-ONE-001", checks: [{ expect: "cart" }], finally: [{ "note-followup": {} }] },
    ]);
    expect(result).toMatchObject({ status: "pass", followups: [] });
    expect(result?.notes).toEqual(["finally check check the ledger: ok"]);
  });

  it("turn a followup step in finally into a note too", async () => {
    const [result] = await run([
      {
        id: "SHOP-ONE-001",
        checks: [{ expect: "cart" }],
        finally: [{ followup: { name: "ledger", hint: "ask finance" } }],
      },
    ]);
    expect(result).toMatchObject({ status: "pass", followups: [] });
    expect(result?.notes).toEqual(["finally check ledger: ok"]);
  });

  it("fail only the finally step that uses a value no step saved", async () => {
    const [result] = await run([
      {
        id: "SHOP-ONE-001",
        checks: [{ expect: "cart" }],
        finally: [{ log: "${case.never}" }, { log: "after" }],
      },
    ]);
    expect(events.at(-1)).toBe('log "after"');
    expect(result).toMatchObject({ status: "pass" });
    expect(result?.notes).toEqual([expect.stringMatching(/^finally step 2 \(log\) failed: /)]);
  });

  it("skip a challenge or guided step with a note", async () => {
    const [result] = await run([
      {
        id: "SHOP-ONE-001",
        checks: [{ expect: "cart" }],
        finally: [{ guided: { title: "Look", steps: ["Open it"] } }, { log: "after" }],
      },
    ]);
    expect(events.at(-1)).toBe('log "after"');
    expect(result?.notes).toEqual([
      "finally step 2 (guided) skipped: finally steps run unattended",
    ]);
  });

  it("note the steps the 2 minute budget left undone", async () => {
    const timeout = AbortSignal.timeout.bind(AbortSignal);
    vi.spyOn(AbortSignal, "timeout").mockImplementation(() => timeout(20));
    const [result] = await run([
      {
        id: "SHOP-ONE-001",
        checks: [{ expect: "cart" }],
        finally: [{ hang: {} }, { log: "late" }, { log: "later" }],
      },
    ]);
    expect(events).not.toContain('log "late"');
    expect(result?.notes).toEqual([
      expect.stringMatching(/^finally step 2 \(hang\) failed: /),
      "finally steps 3 to 4 did not run: the 2 minute budget ran out",
    ]);
  });

  it("run for no case that was blocked before its session launched", async () => {
    const results = await run(
      [
        { id: "SHOP-ONE-001", checks: [{ expect: "cart" }] },
        { id: "SHOP-TWO-001", checks: [{ expect: "cart" }], finally: [{ log: "cleanup" }] },
      ],
      { failingLaunches: [2] },
    );
    expect(events).toEqual(['expect "cart"']);
    expect(results[1]).toMatchObject({ status: "blocked" });
  });
});
