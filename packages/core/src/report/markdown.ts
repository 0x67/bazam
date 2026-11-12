import type { CaseResult, Status } from "../result/index.ts";
import { checkTable } from "./check-table.ts";
import type { TrackerRenderer } from "./post-plan.ts";

/** The label a tracker comment shows for each status. */
export const STATUS_LABELS: Readonly<Record<Status, string>> = {
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
  const followups = result.followups.map(
    (followup) => `- ${escapeMarkdown(`${followup.item}: ${followup.hint}`)}`,
  );
  const table = checkTable(result.checks, (check) => (check.ok ? "ok" : "not ok"));
  const subject = `${result.env}: ${result.caseId} ${result.title} (run ${result.runId})`;
  return [
    `**${STATUS_LABELS[result.status]}** on ${escapeMarkdown(subject)}`,
    ...(result.reason === undefined ? [] : ["", `Reason: ${escapeMarkdown(result.reason)}`]),
    ...(followups.length === 0 ? [] : ["", "Follow-up for a person:", "", ...followups]),
    "",
    "### Evidence",
    "",
    row(table.headers),
    `| ${table.headers.map(() => "---").join(" | ")} |`,
    ...table.rows.map(row),
    ...(result.notes.length === 0 ? [] : ["", `Notes: ${escapeMarkdown(result.notes.join(" "))}`]),
    ...(result.attachments.length === 0
      ? []
      : ["", `Attachments: ${escapeMarkdown(result.attachments.join(", "))}`]),
    "",
  ].join("\n");
}

// a pipe or line break inside a cell would end the table row
function row(cells: readonly string[]): string {
  return `| ${cells.map(escapeMarkdown).join(" | ")} |`;
}

/**
 * Values may come from the app under test, so they stay on one line and render as literal text,
 * also in a table cell or at the start of a list item.
 */
export function escapeMarkdown(text: string): string {
  return text
    .replace(/\s+/g, " ")
    .trim()
    .replace(/[\\`*_~[\]<>&|]/g, "\\$&")
    .replace(/^[#+-]/, "\\$&")
    .replace(/^(\d+)([.)])(?= |$)/, "$1\\$2");
}
