import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { CaseSpec } from "../case/index.ts";
import type { Redactor } from "../redact/index.ts";
import {
  deriveReason,
  deriveStatus,
  type CaseOutcome,
  type CheckRecord,
  type Status,
} from "./status.ts";

type Stage = CaseSpec["stage"];

/** When one top-level step started and how long it took, as the harness measured it. */
export interface StepTime {
  /** The step's number, as failure messages count it. */
  number: number;
  kind: string;
  list: "steps" | "checks" | "finally";
  startedAt: string;
  durationMs: number;
}

export interface CaseResult {
  runId: string;
  caseId: string;
  title: string;
  stage: Stage;
  env: string;
  target: string;
  links: string[];
  status: Status;
  reason?: string;
  checks: CheckRecord[];
  notes: string[];
  /** Notes shown above the fold of a tracker comment instead of in `notes`. */
  callouts: string[];
  followups: { item: string; hint: string }[];
  /** File names inside the case directory, numbered in the order they were taken. */
  attachments: string[];
  challenges: { step: number; kind: string; resolver: string }[];
  identities: string[];
  seed: number;
  values: Record<string, string>;
  /** What the case's steps saved, masked as the rest of the result is. */
  caseValues: Record<string, string>;
  /** The top-level steps the case started, in order; the harness made them, so they are not masked. */
  steps: StepTime[];
  startedAt: string;
  finishedAt: string;
  durationMs: number;
}

/** What the runner knows about a case that the store does not collect itself. */
export interface CaseMeta {
  runId: string;
  title: string;
  stage: Stage;
  env: string;
  target: string;
  links: string[];
  identities: string[];
  seed: number;
  values: Record<string, string>;
  caseValues: Record<string, string>;
  steps: StepTime[];
  startedAt: Date;
}

/** Collects one case's evidence in `<runDir>/<caseId>/`; it masks text and JSON but writes png and zip unchanged. */
export class EvidenceStore {
  readonly #dir: string;
  readonly #caseId: string;
  readonly #redactor: Redactor;
  readonly #checks: CheckRecord[] = [];
  readonly #notes: string[] = [];
  readonly #callouts: string[] = [];
  // one slot per number taken; a slot stays undefined until its file is on disk
  readonly #attachments: (string | undefined)[] = [];
  readonly #challenges: CaseResult["challenges"] = [];

  constructor(runDir: string, caseId: string, redactor: Redactor) {
    this.#dir = join(runDir, caseId);
    this.#caseId = caseId;
    this.#redactor = redactor;
  }

  /** Returns whether the check passed. */
  record(check: CheckRecord): boolean {
    this.#checks.push(check);
    return check.ok;
  }

  note(text: string): void {
    this.#notes.push(text);
  }

  /** A note shown above the fold of a tracker comment instead of in the notes list. */
  callout(text: string): void {
    this.#callouts.push(text);
  }

  /** Records an item a person still has to confirm, so a case that otherwise passes ends `followup`. */
  followup(item: string, hint: string): void {
    this.#checks.push(followupCheck(item, hint));
  }

  /** Writes `<NN>-<label>.<ext>` and returns that file name. A failed write uses up its number but stays out of the result. */
  async attach(
    label: string,
    bytes: Uint8Array,
    ext: "png" | "zip" | "txt" | "json",
  ): Promise<string> {
    const content = maskedContent(this.#redactor, bytes, ext);
    // the number is taken before the first await, so concurrent attachments keep the order they were taken in
    const slot = this.#attachments.push(undefined) - 1;
    const name = `${String(slot + 1).padStart(2, "0")}-${slug(this.#redactor.text(label))}.${ext}`;
    await mkdir(this.#dir, { recursive: true });
    await writeFile(join(this.#dir, name), content);
    this.#attachments[slot] = name;
    return name;
  }

  challenge(step: number, kind: string, resolver: string): void {
    this.#challenges.push({ step, kind, resolver });
  }

  /** Writes result.json and returns the masked result it wrote. */
  async finish(outcome: CaseOutcome, meta: CaseMeta, now: Date): Promise<CaseResult> {
    const reason = deriveReason(this.#checks, outcome);
    const result: CaseResult = {
      runId: meta.runId,
      caseId: this.#caseId,
      title: meta.title,
      stage: meta.stage,
      env: meta.env,
      target: meta.target,
      links: meta.links,
      status: deriveStatus(this.#checks, outcome),
      ...(reason === undefined ? {} : { reason }),
      checks: this.#checks,
      notes: this.#notes,
      callouts: this.#callouts,
      followups: this.#checks
        .filter((check) => check.kind === "followup")
        .map((check) => ({ item: check.name, hint: check.hint ?? "" })),
      attachments: this.#attachments.filter((name) => name !== undefined),
      challenges: this.#challenges,
      identities: meta.identities,
      seed: meta.seed,
      values: meta.values,
      caseValues: meta.caseValues,
      steps: meta.steps,
      startedAt: meta.startedAt.toISOString(),
      finishedAt: now.toISOString(),
      durationMs: now.getTime() - meta.startedAt.getTime(),
    };
    // the harness makes the seed, run values, step times and duration, so none is a secret, but the digit-run pattern would mask long ones
    const masked: CaseResult = {
      ...this.#redactor.value(result),
      seed: meta.seed,
      values: meta.values,
      steps: meta.steps,
      durationMs: result.durationMs,
    };
    await mkdir(this.#dir, { recursive: true });
    await writeFile(join(this.#dir, "result.json"), `${JSON.stringify(masked, null, 2)}\n`);
    return masked;
  }
}

/** The record a follow-up item is stored as. */
export function followupCheck(item: string, hint: string): CheckRecord {
  return {
    name: item,
    kind: "followup",
    expected: "checked by a person",
    observed: "not automated",
    ok: true,
    hint,
  };
}

function maskedContent(
  redactor: Redactor,
  bytes: Uint8Array,
  ext: "png" | "zip" | "txt" | "json",
): Uint8Array | string {
  // binary goes to disk unchanged: Redactor.value would decode it as UTF-8 and return text
  if (ext === "png" || ext === "zip") return bytes;
  const text = new TextDecoder().decode(bytes);
  if (ext === "txt") return redactor.text(text);
  return `${JSON.stringify(redactor.value(JSON.parse(text) as unknown), null, 2)}\n`;
}

function slug(label: string): string {
  return label
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
}
