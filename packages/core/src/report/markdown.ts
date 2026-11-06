import type { CaseResult, Status } from "../result/index.ts";
import type { TrackerRenderer } from "./post-plan.ts";

const OUTCOME: Record<Status, string> = {
  pass: "Passed",
  fail: "Failed",
  blocked: "Blocked",
  followup: "Needs follow-up",
};

/** Plain Markdown comments for a tracker without a renderer of its own; attachments are listed by file name. */
export function markdownTracker(tracker: string): TrackerRenderer {
  return { tracker, render: (result) => ({ markdown: markdownComment(result) }) };
}

function markdownComment(result: CaseResult): string {
  const followups = result.followups.map((followup) => `- ${followup.item}: ${followup.hint}`);
  return [
    `**${OUTCOME[result.status]}** on ${result.env}: ${result.caseId} ${result.title} (run ${result.runId})`,
    ...(result.reason === undefined ? [] : ["", `Reason: ${result.reason}`]),
    ...(followups.length === 0 ? [] : ["", "Follow-up for a person:", "", ...followups]),
    "",
    "### Evidence",
    "",
    "| Check | Expected | Observed | Result |",
    "| --- | --- | --- | --- |",
    ...result.checks.map((check) => row([check.name, cell(check.expected), cell(check.observed), check.ok ? "ok" : "not ok"])),
    ...(result.notes.length === 0 ? [] : ["", `Notes: ${result.notes.join(" ")}`]),
    ...(result.attachments.length === 0 ? [] : ["", `Attachments: ${result.attachments.join(", ")}`]),
    "",
  ].join("\n");
}

function cell(value: unknown): string {
  if (value === undefined) return "";
  return typeof value === "string" ? value : JSON.stringify(value);
}

// a pipe or line break inside a cell would end the table row
function row(cells: readonly string[]): string {
  return `| ${cells.map((text) => text.replaceAll("|", "\\|").replace(/\s*\n\s*/g, " ")).join(" | ")} |`;
}
