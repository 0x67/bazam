import { mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { BRAND } from "@bazam/core/brand";
import { RunValues } from "@bazam/core/env";
import { PluginRegistry } from "@bazam/core/plugin";
import { loadProject, loadProjectConfig } from "@bazam/core/project";
import { defaultRedactionRules, Redactor } from "@bazam/core/redact";
import { runCases } from "@bazam/core/run";
import { strFromU8, unzipSync } from "fflate";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vite-plus/test";
import plugin from "../src/index.ts";
import { html, startSite, tempDir, type Site } from "./support/site.ts";

vi.setConfig({ testTimeout: 60_000, hookTimeout: 30_000 });

const BADGE = "BADGE-4417-ZX";
const RUN_ID = "20261107-101500-0a1b";

describe("masking a typed fixture value on chromium", () => {
  let site: Site;
  let root: string | undefined;

  beforeAll(async () => {
    site = await startSite({ "/": html('<h1>Form</h1><input data-testid="badge">') });
  });

  afterAll(() => site.close());

  afterEach(async () => {
    if (root !== undefined) await rm(root, { recursive: true, force: true });
  });

  it("keeps the value out of the trace a failed case attaches", async () => {
    root = await tempDir();
    const files: Record<string, unknown> = {
      [BRAND.configFile]: {
        envs: { demo: { production: false, vars: {}, hosts: ["127.0.0.1"] } },
        targets: { web: { driver: "playwright", browser: "chromium" } },
        identities: { alice: { fixture: "alice", auth: {} } },
      },
      "fixtures/identities.local.yaml": { alice: { email: "alice@example.test", badge: BADGE } },
      "cases/web/form.yaml": {
        cases: [
          {
            id: "WEB-MASK-001",
            title: "types a badge",
            stage: "acceptance",
            risk: "low",
            links: ["jira:DEMO-7"],
            targets: ["web"],
            steps: [
              { open: `${site.origin}/`, as: "alice" },
              { fill: { field: { id: "badge" }, value: "${identity.alice.badge}" }, as: "alice" },
              { fill: { field: { id: "badge" }, value: "${case.missing}" }, as: "alice" },
            ],
          },
        ],
      },
    };
    for (const [path, content] of Object.entries(files)) {
      await mkdir(dirname(join(root, path)), { recursive: true });
      await writeFile(join(root, path), JSON.stringify(content));
    }
    const { config } = await loadProjectConfig(root);
    const registry = await PluginRegistry.load(config!, root, [plugin]);
    const project = await loadProject(root, registry);
    expect(project.issues).toEqual([]);
    const runDir = join(root, "runs", RUN_ID);

    try {
      const [result] = await runCases({
        project,
        env: project.config.envs["demo"]!,
        cases: project.cases,
        registry,
        channel: { ask: async () => ({ kind: "done" }) },
        runDir,
        runValues: new RunValues(RUN_ID, new Date("2026-11-07T10:15:00Z"), 7),
        seed: 7,
        redactor: new Redactor(defaultRedactionRules()),
        signal: new AbortController().signal,
      });
      expect(result?.status).toBe("blocked");
    } finally {
      await registry.close();
    }

    const caseDir = join(runDir, "WEB-MASK-001");
    const traces = (await readdir(caseDir)).filter((name) => name.endsWith(".zip"));
    expect(traces.length).toBeGreaterThan(0);
    for (const trace of traces) {
      const entries = unzipSync(await readFile(join(caseDir, trace)));
      expect(Object.keys(entries).length).toBeGreaterThan(0);
      for (const [name, bytes] of Object.entries(entries)) {
        expect([trace, name, strFromU8(bytes).includes(BADGE)]).toEqual([trace, name, false]);
      }
    }
  });
});
