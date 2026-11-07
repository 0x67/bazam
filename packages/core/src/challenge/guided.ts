import type { CheckRecord } from "../result/index.ts";
import type { PersonAnswer } from "./human.ts";

/** The state a guided step observed for itself after the person answered. */
export type GuidedObservation = { ok: boolean; observed: string };

/** The person answered `blocked`, gave no verdict in time, or answered something other than a verdict. */
export class GuidedBlocked extends Error {
  constructor(reason: string) {
    super(reason);
    this.name = "GuidedBlocked";
  }
}

const DISAGREEMENT_HINT = "person answered pass but the observed state disagrees";

/** The check passes only when the person answered `pass` and the observation, when there is one, agrees. */
export function checkGuidedOutcome(
  name: string,
  expected: string,
  answer: PersonAnswer,
  observation: GuidedObservation | undefined,
): CheckRecord {
  if (answer.kind === "timeout") throw new GuidedBlocked(`no verdict from a person for "${name}" in time`);
  if (answer.kind !== "verdict")
    throw new GuidedBlocked(`the person answered ${answer.kind} for "${name}", which needs a verdict`);
  const said = answer.note === "" ? answer.verdict : `${answer.verdict}: ${answer.note}`;
  if (answer.verdict === "blocked") throw new GuidedBlocked(`person: ${said}`);

  const observed = observation === undefined ? said : `${said}; observed: ${observation.observed}`;
  const disagrees = answer.verdict === "pass" && observation?.ok === false;
  const check: CheckRecord = { name, kind: "guided", expected, observed, ok: answer.verdict === "pass" && !disagrees };
  return disagrees ? { ...check, hint: DISAGREEMENT_HINT } : check;
}
