import { join } from "node:path";
import { readdir, readFile, rm } from "node:fs/promises";
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

const ACCOUNT = "ACCT-77001234";
const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

// both steps note what they were given, so a value registered before the handler runs shows up masked
const steps: StepHandler[] = [
  {
    kind: "fill",
    schema: z.unknown(),
    run: async (written, ctx) => {
      ctx.evidence.note("fill ran");
      const { value } = (await ctx.resolve(written)) as { value: string };
      ctx.evidence.note(`typed ${value}`);
    },
  },
  {
    kind: "reveal",
    schema: z.unknown(),
    run: async (value, ctx) => {
      ctx.mask(value as string);
      ctx.evidence.note(`saw ${value as string}`);
    },
  },
];

async function run(
  stepsList: Record<string, unknown>[],
  redaction: Record<string, unknown> = {},
): Promise<{ result: CaseResult; files: Record<string, string> }> {
  const plugin = definePlugin({
    name: "test-mask",
    apiVersion: PLUGIN_API_VERSION,
    drivers: [fakeDriver({ steps })],
  });
  const { root, project, registry } = await loadTestProject(
    {
      [BRAND.configFile]: {
        envs: { demo: { production: false, vars: {}, hosts: ["app.example.test"] } },
        targets: { web: { driver: "fake" } },
        identities: { alice: { fixture: "alice", auth: {} } },
        redaction,
      },
      "fixtures/identities.local.yaml": {
        alice: { email: "alice@example.test", phone: "+447700900123", badge: "BADGE-4417" },
      },
      "cases/shop/run.yaml": {
        cases: [
          {
            id: "SHOP-ONE-001",
            title: "a case",
            stage: "acceptance",
            risk: "low",
            links: ["jira:DEMO-7"],
            targets: ["web"],
            steps: stepsList,
          },
        ],
      },
    },
    [plugin],
  );
  roots.push(root);
  const runDir = join(root, "runs", "20261107-101500-0a1b");
  const [result] = await runCases({
    project,
    env: project.config.envs["demo"]!,
    cases: project.cases,
    registry,
    channel: { ask: async () => ({ kind: "done" }) },
    runDir,
    runValues: new RunValues("20261107-101500-0a1b", new Date("2026-11-07T10:15:00Z"), 7),
    seed: 7,
    redactor: new Redactor(defaultRedactionRules()),
    signal: new AbortController().signal,
  });
  const files: Record<string, string> = {};
  for (const entry of await readdir(runDir, { recursive: true, withFileTypes: true })) {
    if (!entry.isFile()) continue;
    const path = join(entry.parentPath, entry.name);
    files[path.slice(runDir.length + 1)] = await readFile(path, "utf8");
  }
  return { result: result!, files };
}

describe("masking typed values", () => {
  it("masks a value a step registers in a later note and every file of the run", async () => {
    const { result, files } = await run([{ reveal: ACCOUNT }, { note: `again ${ACCOUNT}` }]);
    expect(result.notes).toEqual(["saw [redacted]", "again [redacted]"]);
    expect(JSON.stringify(files)).not.toContain(ACCOUNT);
    expect(files["SHOP-ONE-001/result.json"]).toContain("[redacted]");
  });

  it("leaves a value under 4 characters as it is", async () => {
    const { result } = await run([{ reveal: "abc" }]);
    expect(result.notes).toEqual(["saw abc"]);
  });

  it("registers the identity field a fill types before the handler runs", async () => {
    const { result, files } = await run([{ fill: { value: "${identity.alice.phone.national}" }, as: "alice" }]);
    expect(result.notes).toEqual(["fill ran", "typed [redacted]"]);
    expect(JSON.stringify(files)).not.toContain("7700900123");
  });

  it("registers nothing for a field that redaction.shown lists", async () => {
    const fill = [{ fill: { value: "${identity.alice.badge}" }, as: "alice" }];
    expect((await run(fill)).result.notes).toEqual(["fill ran", "typed [redacted]"]);
    expect((await run(fill, { shown: ["badge"] })).result.notes).toEqual(["fill ran", "typed BADGE-4417"]);

    const phone = [{ fill: { value: "${identity.alice.phone.national}" }, as: "alice" }];
    expect((await run(phone, { shown: ["phone"] })).result.notes).toEqual(["fill ran", "typed ••••0123"]);
  });

  it("registers nothing for plain text", async () => {
    const { result } = await run([{ fill: { value: "hello world" } }]);
    expect(result.notes).toEqual(["fill ran", "typed hello world"]);
  });

  it("leaves an unresolved placeholder to the handler", async () => {
    const { result } = await run([{ fill: { value: "${identity.alice.nickname}" }, as: "alice" }]);
    expect(result.status).toBe("blocked");
    expect(result.notes).toContain("fill ran");
  });
});
