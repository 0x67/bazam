import type { CaseResult } from "../result/index.ts";
import { cellText } from "./check-table.ts";

export interface Callout {
  tone: "error" | "success";
  text: string;
}

/** The callout notes, then the callout checks in the order they were recorded. */
export function calloutsOf(result: CaseResult): Callout[] {
  // a result.json written before callouts existed lacks the field
  const notes = (result as { callouts?: string[] }).callouts ?? [];
  const checks = result.checks
    .filter((check) => check.callout === true && check.kind !== "followup")
    .map((check): Callout => ({
      tone: check.ok ? "success" : "error",
      text: `${check.name}: expected ${cellText(check.expected)}, observed ${cellText(check.observed)}`,
    }));
  return [...notes.map((text): Callout => ({ tone: "error", text })), ...checks];
}
