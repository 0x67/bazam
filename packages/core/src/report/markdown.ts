import type { CaseResult, Status } from "../result/index.ts";
import { calloutsOf } from "./callouts.ts";
import { checkTable } from "./check-table.ts";
import type { RenderOptions, TrackerRenderer } from "./post-plan.ts";
import { DEFAULT_RESULT_LINE, resultLineParts, type ResultLinePart } from "./result-line.ts";

/** The label a tracker comment shows for each status. */
export const STATUS_LABELS: Readonly<Record<Status, string>> = {
  pass: "Passed",
  fail: "Failed",
  blocked: "Blocked",
  followup: "Needs follow-up",
};

/** Plain Markdown comments for a tracker without a renderer of its own; attachments are listed by file name. */
export function markdownTracker(tracker: string): TrackerRenderer {
  return { tracker, render: (result, options) => ({ markdown: markdownComment(result, options) }) };
}

function markdownComment(result: CaseResult, options: RenderOptions = {}): string {
  const followups = result.followups.map(
    (followup) => `- ${escapeMarkdown(`${followup.item}: ${followup.hint}`)}`,
  );
  const callouts = calloutsOf(result).flatMap((callout) => [
    "",
    `${callout.tone === "error" ? "**Attention:**" : "**Confirmed:**"} ${escapeMarkdown(callout.text)}`,
  ]);
  const table = checkTable(result.checks, (check) => (check.ok ? "ok" : "not ok"));
  return [
    markdownResultLine(result, options.resultLine),
    ...(result.reason === undefined ? [] : ["", `Reason: ${escapeMarkdown(result.reason)}`]),
    ...callouts,
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

/** The result line as Markdown: the status bold, each text part escaped with the space at its edges kept. */
export function markdownResultLine(result: CaseResult, template = DEFAULT_RESULT_LINE): string {
  return resultLineParts(template, result).map(markdownPart).join("");
}

function markdownPart(part: ResultLinePart): string {
  if ("status" in part) return `**${STATUS_LABELS[part.status]}**`;
  const lead = /^\s/.test(part.text) ? " " : "";
  const trail = /\s$/.test(part.text) ? " " : "";
  const body = escapeMarkdown(part.text);
  return body === "" ? lead : `${lead}${body}${trail}`;
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
