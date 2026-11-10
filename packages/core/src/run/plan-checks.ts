import type { CaseSpec, LoadedCase } from "../case/index.ts";
import type { GuardedHttp } from "../driver/index.ts";
import { ProdWriteRefused, type Environment } from "../env/index.ts";
import type { Redactor } from "../redact/index.ts";
import { messageOf } from "./outcome.ts";
import { loginReason, type RunPlan } from "./plan.ts";

export interface PlanCheckCase {
  caseId: string;
  target: string;
  identities: readonly string[];
  spec: CaseSpec;
}

export interface PlanCheckInput {
  env: Environment;
  cases: readonly PlanCheckCase[];
  /** The run's HTTP client; it sends as an identity when asked, and refuses writes in a production env. */
  http: GuardedHttp;
  secret(key: string): Promise<string>;
  /**
   * Fills `${identity.…}`, `${env.…}` and `${secret.…}` in `value` as a step's `ctx.resolve` does, a bound role included.
   * `${case.…}` and `${run.…}` throw UnresolvedPlaceholder, since a plan check belongs to no case.
   */
  resolve<T>(value: T): Promise<T>;
}

export interface PlanCheck {
  name: string;
  /** Reasons by case id, for the cases this check blocks. */
  check(input: PlanCheckInput): Promise<Readonly<Record<string, string>>>;
}

export interface PlanCheckRun {
  plan: RunPlan;
  /** In plan order, so a case sits at its planned position. */
  cases: readonly LoadedCase[];
  /** The reasons of the logins preflight could not get, by login key. */
  loginsBlocked: ReadonlyMap<string, string>;
  env: Environment;
  http: GuardedHttp;
  secret: (key: string) => Promise<string>;
  resolve: <T>(value: T) => Promise<T>;
  redactor: Redactor;
  log(line: string): void;
}

const READ_ONLY_METHODS: ReadonlySet<string> = new Set(["GET", "HEAD"]);

/** Runs each plan check over the cases still unblocked and blocks the ones it names. */
export async function runPlanChecks(checks: readonly PlanCheck[], run: PlanCheckRun): Promise<void> {
  const { plan, cases, env, redactor } = run;
  const http: GuardedHttp = {
    send: async (request, as) => {
      const method = request.method.toUpperCase();
      if (env.production && !READ_ONLY_METHODS.has(method)) throw new ProdWriteRefused(method, env.name);
      return run.http.send(request, as);
    },
  };
  for (const check of checks) {
    const given = plan.cases.flatMap((planned, position) => {
      const loaded = cases[position];
      const open = planned.blocked === undefined && loginReason(planned, run.loginsBlocked) === undefined;
      return open && loaded !== undefined ? [{ planned, given: toCase(planned, loaded) }] : [];
    });
    if (given.length === 0) continue;
    let reasons: Readonly<Record<string, string>>;
    try {
      reasons = await check.check({
        env,
        cases: given.map((entry) => entry.given),
        http,
        secret: run.secret,
        resolve: run.resolve,
      });
    } catch (error) {
      const reason = `internal: plan check ${check.name} failed: ${messageOf(error)}`;
      reasons = Object.fromEntries(given.map((entry) => [entry.given.caseId, reason]));
    }
    for (const [caseId, reason] of Object.entries(reasons)) {
      const entry = given.find((candidate) => candidate.given.caseId === caseId);
      if (entry === undefined) run.log(`plan check ${check.name} named ${caseId}, which is not a case it was given`);
      else entry.planned.blocked = redactor.text(reason);
    }
  }
}

function toCase(planned: RunPlan["cases"][number], loaded: LoadedCase): PlanCheckCase {
  return { caseId: planned.caseId, target: planned.target, identities: planned.identities, spec: loaded.spec };
}
