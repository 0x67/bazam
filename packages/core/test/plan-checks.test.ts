import { describe, expect, it } from "vite-plus/test";
import { CaseSpec, type LoadedCase } from "../src/case/index.ts";
import type { GuardedHttp } from "../src/driver/index.ts";
import { EnvsConfig, ProdWriteRefused } from "../src/env/index.ts";
import { defaultRedactionRules, Redactor } from "../src/redact/index.ts";
import type { PlannedCase, RunPlan } from "../src/run/index.ts";
import { runPlanChecks, type PlanCheck, type PlanCheckRun } from "../src/run/plan-checks.ts";

const envs = EnvsConfig.parse({
  uat: { production: false, vars: {}, hosts: ["api.example.test"] },
  live: { production: true, vars: {}, hosts: ["api.example.test"] },
});
const URL_TO_CALL = new URL("https://api.example.test/balance");

function planned(caseId: string, fields: Partial<PlannedCase> = {}): PlannedCase {
  return { caseId, target: "web", stage: "acceptance", identities: [], logins: [], challenges: [], ...fields };
}

function loaded(caseId: string): LoadedCase {
  const spec = CaseSpec.parse({ id: caseId, title: caseId, stage: "acceptance", risk: "low", targets: ["web"] });
  return { spec } as LoadedCase;
}

interface Setup {
  cases?: PlannedCase[];
  env?: "uat" | "live";
  http?: GuardedHttp;
  loginsBlocked?: ReadonlyMap<string, string>;
}

function setup(options: Setup = {}): { run: PlanCheckRun; plan: RunPlan; logged: string[]; redactor: Redactor } {
  const cases = options.cases ?? [planned("DEMO-A-001"), planned("DEMO-A-002"), planned("DEMO-A-003")];
  const plan: RunPlan = { env: "uat", cases, confirmations: [], personSteps: 0, roles: {} };
  const logged: string[] = [];
  const redactor = new Redactor(defaultRedactionRules());
  const run: PlanCheckRun = {
    plan,
    cases: cases.map(({ caseId }) => loaded(caseId)),
    loginsBlocked: options.loginsBlocked ?? new Map(),
    env: envs[options.env ?? "uat"]!,
    http: options.http ?? { send: async () => new Response("{}") as never },
    secret: async () => "fake-secret-value",
    resolve: async (value) => value,
    redactor,
    log: (line) => logged.push(line),
  };
  return { run, plan, logged, redactor };
}

function check(name: string, answer: PlanCheck["check"]): PlanCheck {
  return { name, check: answer };
}

describe("runPlanChecks", () => {
  it("blocks the case a check names with its reason and leaves the others", async () => {
    const { run, plan } = setup();

    await runPlanChecks([check("budget", async () => ({ "DEMO-A-002": "balance 5 is under the 9 planned" }))], run);

    expect(plan.cases.map((entry) => entry.blocked)).toEqual([
      undefined,
      "balance 5 is under the 9 planned",
      undefined,
    ]);
  });

  it("gives each check only the cases the checks before it left unblocked", async () => {
    const { run } = setup();
    const seen: string[][] = [];

    await runPlanChecks(
      [
        check("first", async () => ({ "DEMO-A-001": "over budget" })),
        check("second", async ({ cases }) => {
          seen.push(cases.map((entry) => entry.caseId));
          return {};
        }),
      ],
      run,
    );

    expect(seen).toEqual([["DEMO-A-002", "DEMO-A-003"]]);
  });

  it("skips a case that the plan or a failed login blocked, and passes target, identities and spec", async () => {
    const logins = [{ identity: "buyer", surface: "web", mode: "cached" as const }];
    const { run } = setup({
      cases: [
        planned("DEMO-A-001", { blocked: "target web is not configured" }),
        planned("DEMO-A-002", { logins, identities: ["buyer"] }),
        planned("DEMO-A-003", { target: "mobile", identities: ["seller"] }),
      ],
      loginsBlocked: new Map([["buyer/web", "login failed"]]),
    });
    const seen: unknown[] = [];

    await runPlanChecks([check("budget", async ({ cases }) => (seen.push(...cases), {}))], run);

    expect(seen).toEqual([
      { caseId: "DEMO-A-003", target: "mobile", identities: ["seller"], spec: run.cases[2]!.spec },
    ]);
  });

  it("logs and ignores an id that is not a case it was given", async () => {
    const { run, plan, logged } = setup({
      cases: [planned("DEMO-A-001", { blocked: "earlier reason" }), planned("DEMO-A-002")],
    });

    await runPlanChecks([check("budget", async () => ({ "DEMO-A-001": "late", "DEMO-A-404": "no such case" }))], run);

    expect(plan.cases.map((entry) => entry.blocked)).toEqual(["earlier reason", undefined]);
    expect(logged).toEqual([
      "plan check budget named DEMO-A-001, which is not a case it was given",
      "plan check budget named DEMO-A-404, which is not a case it was given",
    ]);
  });

  it("masks a registered secret in a reason and in a thrown message", async () => {
    const { run, plan, redactor } = setup();
    redactor.register("fake-account-token-77");

    await runPlanChecks(
      [
        check("leaky", async () => ({ "DEMO-A-001": "balance read with fake-account-token-77" })),
        check("thrower", async () => {
          throw new Error("rejected fake-account-token-77");
        }),
      ],
      run,
    );

    expect(plan.cases[0]?.blocked).toBe("balance read with [redacted]");
    expect(plan.cases[1]?.blocked).toBe("internal: plan check thrower failed: rejected [redacted]");
  });

  it("hands the run's resolve to each check", async () => {
    const { run, plan } = setup({ cases: [planned("DEMO-A-001")] });
    run.resolve = async <T>(value: T) => (value === "${env.APP_URL}" ? "https://app.example.test" : value) as T;

    await runPlanChecks(
      [check("lookup", async (input) => ({ "DEMO-A-001": `saw ${await input.resolve("${env.APP_URL}")}` }))],
      run,
    );

    expect(plan.cases[0]?.blocked).toBe("saw https://app.example.test");
  });

  it("blocks every case it was given when a check throws", async () => {
    const { run, plan } = setup({ cases: [planned("DEMO-A-001"), planned("DEMO-A-002", { blocked: "earlier" })] });

    await runPlanChecks(
      [
        check("budget", async () => {
          throw new Error("balance service is down");
        }),
      ],
      run,
    );

    expect(plan.cases.map((entry) => entry.blocked)).toEqual([
      "internal: plan check budget failed: balance service is down",
      "earlier",
    ]);
  });

  it("refuses a write from a check in a production env, and sends a read or a write elsewhere", async () => {
    const sent: string[] = [];
    const http: GuardedHttp = {
      send: async (request) => (sent.push(request.method), new Response("{}") as never),
    };
    const results: Record<string, string> = {};
    const probe = check("budget", async (input) => {
      for (const method of ["GET", "head", "POST"]) {
        try {
          await input.http.send({ method, url: URL_TO_CALL, headers: new Headers() });
          results[`${input.env.name} ${method}`] = "sent";
        } catch (error) {
          results[`${input.env.name} ${method}`] = error instanceof ProdWriteRefused ? error.message : "other";
        }
      }
      return {};
    });

    await runPlanChecks([probe], setup({ env: "live", http }).run);
    await runPlanChecks([probe], setup({ env: "uat", http }).run);

    expect(results).toEqual({
      "live GET": "sent",
      "live head": "sent",
      "live POST": "POST needs write: true in production env live",
      "uat GET": "sent",
      "uat head": "sent",
      "uat POST": "sent",
    });
    expect(sent).toEqual(["GET", "head", "GET", "head", "POST"]);
  });
});
