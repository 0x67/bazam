import type { Identities } from "../auth/index.ts";
import { loginKey, type PlannedCase, type RunPlan } from "./plan.ts";

export interface PreflightResult {
  /** Reasons by `<identity>/<surface>`, as loginKey writes it. */
  blocked: ReadonlyMap<string, string>;
}

type PlannedLogin = PlannedCase["logins"][number];

/**
 * Leaves every credential the unblocked cases need ready before the first case: cached, refreshed, static and
 * scripted ones first, then person logins one after another. A login that fails blocks its identity and surface.
 */
export async function preflight(plan: RunPlan, identities: Identities): Promise<PreflightResult> {
  const logins = new Map<string, PlannedLogin>();
  for (const planned of plan.cases) {
    if (planned.blocked === undefined)
      for (const login of planned.logins) logins.set(loginKey(login), login);
  }
  // sort is stable, so each group keeps the plan's order
  const ordered = [...logins.values()].sort(
    (a, b) => Number(a.mode === "person") - Number(b.mode === "person"),
  );
  const blocked = new Map<string, string>();
  for (const login of ordered) {
    try {
      await identities.ensureCredential(login.identity, login.surface);
    } catch (error) {
      blocked.set(
        loginKey(login),
        `login of ${login.identity} on ${login.surface} failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
  return { blocked };
}
