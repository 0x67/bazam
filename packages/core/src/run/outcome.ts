import { CredentialRejected, RefreshLockTimeout } from "../auth/index.ts";
import { ChallengeBlocked, GuidedBlocked } from "../challenge/index.ts";
import { ConnectionFailed, Unauthorized } from "../driver/http.ts";
import { HostNotAllowed, ProdCaseRefused, ProdWriteRefused, UnresolvedPlaceholder } from "../env/index.ts";
import type { CaseOutcome } from "../result/index.ts";
import { SecretMissing } from "../secrets/index.ts";

/** The environment, the test data or a credential stopped the case; the message is the reason. */
export class CaseBlocked extends Error {
  constructor(reason: string) {
    super(reason);
    this.name = "CaseBlocked";
  }
}

/** A step handler threw something other than a blocking error, which the product caused. */
export class StepFailed extends Error {
  constructor(step: number, kind: string, cause: unknown) {
    super(`step ${step} (${kind}): ${messageOf(cause)}`, { cause });
    this.name = "StepFailed";
  }
}

const BLOCKING = [
  HostNotAllowed,
  ProdCaseRefused,
  ProdWriteRefused,
  UnresolvedPlaceholder,
  SecretMissing,
  Unauthorized,
  ConnectionFailed,
  RefreshLockTimeout,
  CredentialRejected,
  ChallengeBlocked,
  GuidedBlocked,
  CaseBlocked,
];

export function isBlocking(error: unknown): error is Error {
  return BLOCKING.some((type) => error instanceof type);
}

/** How a case ended after `error` stopped it. Anything neither blocking nor from a step is a harness error. */
export function outcomeOf(error: unknown, cancelled: boolean): CaseOutcome {
  if (cancelled) return { kind: "blocked", reason: "run cancelled" };
  if (error instanceof StepFailed) return { kind: "errored", source: "product", message: error.message };
  if (isBlocking(error)) return { kind: "blocked", reason: error.message };
  return { kind: "errored", source: "harness", message: messageOf(error) };
}

export function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
