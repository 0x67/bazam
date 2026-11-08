export type Status = "pass" | "fail" | "blocked" | "followup";
export type CheckKind = "ui" | "api" | "guided" | "followup" | "external";

export interface CheckRecord {
  name: string;
  kind: CheckKind;
  expected: unknown;
  observed: unknown;
  ok: boolean;
  hint?: string;
}

/** How a case ended, apart from its checks. */
export type CaseOutcome =
  | { kind: "completed" }
  | { kind: "blocked"; reason: string }
  | { kind: "errored"; message: string; source: "product" | "harness" };

/** A failed check outranks every outcome, and a case that recorded no checks never passes. */
export function deriveStatus(checks: readonly CheckRecord[], outcome: CaseOutcome): Status {
  if (checks.some((check) => !check.ok)) return "fail";
  if (outcome.kind === "blocked") return "blocked";
  // an error in the harness itself must never read as a product bug
  if (outcome.kind === "errored") return outcome.source === "harness" ? "blocked" : "fail";
  if (checks.length === 0) return "fail";
  return checks.some((check) => check.kind === "followup") ? "followup" : "pass";
}

/** The reason recorded beside the status; a harness error is prefixed `internal:`. */
export function deriveReason(checks: readonly CheckRecord[], outcome: CaseOutcome): string | undefined {
  switch (outcome.kind) {
    case "blocked":
      return outcome.reason;
    case "errored":
      return outcome.source === "harness" ? `internal: ${outcome.message}` : outcome.message;
    case "completed":
      return checks.length === 0 ? "no checks recorded" : undefined;
  }
}
