import { join } from "node:path";
import type { Redactor } from "../redact/index.ts";
import { EvidenceStore, type CheckRecord } from "../result/index.ts";

/** The evidence store a case runs with. It also keeps what the runner needs before result.json exists. */
export class CaseEvidence extends EvidenceStore {
  readonly #dir: string;
  readonly #checks: CheckRecord[] = [];
  #captured: CheckRecord[] | undefined;
  #screenshot: string | undefined;

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

  override record(check: CheckRecord): boolean {
    if (this.#captured !== undefined) {
      this.#captured.push(check);
      return check.ok;
    }
    this.#checks.push(check);
    return super.record(check);
  }

  override followup(item: string, hint: string): void {
    super.followup(item, hint);
    // deriveStatus reads only the kind and ok of a followup
    this.#checks.push({ name: item, kind: "followup", expected: undefined, observed: undefined, ok: true, hint });
  }

  override async attach(label: string, bytes: Uint8Array, ext: "png" | "zip" | "txt" | "json"): Promise<string> {
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
}
