import { join } from "node:path";
import type { Redactor } from "../redact/index.ts";
import { EvidenceStore, followupCheck, type CheckRecord } from "../result/index.ts";

/** The marks a step puts on the checks it records. */
export interface StepMarks {
  level?: string;
  callout?: boolean;
}

/** The evidence store a case runs with. It also keeps what the runner needs before result.json exists. */
export class CaseEvidence extends EvidenceStore {
  readonly #dir: string;
  readonly #checks: CheckRecord[] = [];
  #captured: CheckRecord[] | undefined;
  #aside: CheckRecord[] | undefined;
  #screenshot: string | undefined;
  #marks: StepMarks = {};

  constructor(runDir: string, caseId: string, redactor: Redactor) {
    super(runDir, caseId, redactor);
    this.#dir = join(runDir, caseId);
  }

  /** The checks recorded so far, followups included; the runner derives from them the status it closes the driver session with. */
  get checks(): readonly CheckRecord[] {
    return this.#checks;
  }

  /** Path of the latest screenshot, for a person's prompt. */
  get latestScreenshot(): string | undefined {
    return this.#screenshot;
  }

  override record(stored: CheckRecord): boolean {
    const check = this.#stamped(stored);
    if (this.#aside !== undefined) {
      this.#aside.push(check);
      return check.ok;
    }
    if (this.#captured !== undefined) {
      this.#captured.push(check);
      return check.ok;
    }
    this.#checks.push(check);
    return super.record(check);
  }

  override followup(item: string, hint: string): void {
    const check = followupCheck(item, hint);
    if (this.#marks.level !== undefined) check.level = this.#marks.level;
    if (this.#aside !== undefined) {
      this.#aside.push(check);
      return;
    }
    super.record(check);
    this.#checks.push(check);
  }

  /** Runs `step`; each check recorded meanwhile gets the marks it does not set itself, and each follow-up the level. */
  async marked(marks: StepMarks, step: () => Promise<void>): Promise<void> {
    const outer = this.#marks;
    this.#marks = { ...outer, ...marks };
    try {
      await step();
    } finally {
      this.#marks = outer;
    }
  }

  #stamped(check: CheckRecord): CheckRecord {
    const { level, callout } = this.#marks;
    return {
      ...check,
      ...(check.level === undefined && level !== undefined ? { level } : {}),
      ...(check.callout === undefined && callout !== undefined ? { callout } : {}),
    };
  }

  override async attach(
    label: string,
    bytes: Uint8Array,
    ext: "png" | "zip" | "txt" | "json",
  ): Promise<string> {
    const name = await super.attach(label, bytes, ext);
    if (ext === "png") this.#screenshot = join(this.#dir, name);
    return name;
  }

  /** Runs `step` and returns the checks it recorded instead of adding them to the case, as a guided step's observe needs. */
  async capture(step: () => Promise<void>): Promise<CheckRecord[]> {
    const captured: CheckRecord[] = [];
    this.#captured = captured;
    try {
      await step();
    } finally {
      this.#captured = undefined;
    }
    return captured;
  }

  /** Runs `step` with every check and follow-up it records kept out of the case, and returns them. */
  async recordAside(step: () => Promise<void>): Promise<CheckRecord[]> {
    const aside: CheckRecord[] = [];
    this.#aside = aside;
    try {
      await step();
    } finally {
      this.#aside = undefined;
    }
    return aside;
  }
}
