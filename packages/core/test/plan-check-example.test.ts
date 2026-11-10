import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vite-plus/test";
import { CaseSpec, type LoadedCase } from "../src/case/index.ts";
import { EnvsConfig } from "../src/env/index.ts";
import { PluginRegistry } from "../src/plugin/index.ts";
import { ProjectConfig } from "../src/project.ts";
import { defaultRedactionRules, Redactor } from "../src/redact/index.ts";
import type { PlannedCase, RunPlan } from "../src/run/index.ts";
import { runPlanChecks } from "../src/run/plan-checks.ts";

const EXAMPLES = fileURLToPath(new URL("../../../examples/", import.meta.url));
const demo = EnvsConfig.parse({ demo: { production: false, hosts: ["example.test"] } })["demo"]!;

let registry: PluginRegistry | undefined;
afterEach(async () => {
  await registry?.close();
  registry = undefined;
});

function planned(caseId: string): PlannedCase {
  return { caseId, target: "web", stage: "acceptance", identities: [], logins: [], challenges: [] };
}

function loaded(caseId: string, tags: string[]): LoadedCase {
  const spec = CaseSpec.parse({ id: caseId, title: caseId, stage: "acceptance", risk: "low", targets: ["web"], tags });
  return { spec } as LoadedCase;
}

describe("the plan check example in examples/plugins/plan-check", () => {
  it("blocks the case tagged hold with its reason and leaves the other", async () => {
    const config = ProjectConfig.parse({ envs: {}, plugins: ["./plugins/plan-check/manifest.ts"] });
    registry = await PluginRegistry.load(config, EXAMPLES, []);
    const plan: RunPlan = {
      env: "demo",
      cases: [planned("DEMO-HOLD-001"), planned("DEMO-OPEN-001")],
      confirmations: [],
      personSteps: 0,
      roles: {},
    };

    await runPlanChecks(registry.planChecks(), {
      plan,
      cases: [loaded("DEMO-HOLD-001", ["hold"]), loaded("DEMO-OPEN-001", ["sign-in"])],
      loginsBlocked: new Map(),
      env: demo,
      http: { send: async () => new Response("{}") as never },
      secret: async () => "fake-secret-value",
      redactor: new Redactor(defaultRedactionRules()),
      log: () => {},
    });

    expect(plan.cases.map((entry) => entry.blocked)).toEqual(["tagged hold; remove the tag to run it", undefined]);
  });
});
