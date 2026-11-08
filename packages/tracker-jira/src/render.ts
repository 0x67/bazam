import { cellText, escapeMarkdown, STATUS_LABELS, type MediaRefs, type TrackerRenderer } from "@bazam/core/report";
import type { CaseResult, CheckRecord } from "@bazam/core/result";
import { checkResult, followupText, renderJiraAdf, resultSubject, type AdfDoc } from "./adf.ts";

type MediaRef = MediaRefs[string];

/**
 * The comment opens with the result line, then follow-ups for a person, then the evidence.
 * The HTML folds the evidence and shows a screenshot inline when `media` holds its uploaded id.
 * Markdown has no fold or media embed (the Atlassian connector stores HTML tags in Markdown as
 * literal text), so its evidence goes under a heading and it lists every file by name. ADF, which
 * the Jira client posts, follows the Markdown in that.
 */
export function renderJiraComment(
  result: CaseResult,
  media: MediaRefs = {},
): { markdown: string; html: string; adf: AdfDoc } {
  return { markdown: markdownComment(result), html: htmlComment(result, media), adf: renderJiraAdf(result) };
}

export const jiraTracker: TrackerRenderer = { tracker: "jira", render: renderJiraComment };

function htmlComment(result: CaseResult, media: MediaRefs): string {
  const figures: string[] = [];
  const listed: string[] = [];
  for (const name of result.attachments) {
    // media keys are paths relative to the run directory, as in PostPlanItem.attachments
    const ref = name.endsWith(".png") ? media[`${result.caseId}/${name}`] : undefined;
    if (ref === undefined) listed.push(name);
    else figures.push(figure(name, ref));
  }
  const evidence = [
    result.checks.length === 0
      ? ""
      : `<table><thead><tr><th>Check</th><th>Expected</th><th>Observed</th><th>Result</th></tr></thead><tbody>${result.checks.map(htmlRow).join("")}</tbody></table>`,
    htmlList("Notes:", result.notes),
    ...figures,
    listed.length === 0 ? "" : `<p>Attached files: ${escapeHtml(listed.join(", "))}</p>`,
  ].join("");
  return [
    `<p><strong>${STATUS_LABELS[result.status]}</strong> on ${escapeHtml(resultSubject(result))}</p>`,
    result.reason === undefined ? "" : `<p>Reason: ${escapeHtml(result.reason)}</p>`,
    htmlList("Follow-up for a person:", result.followups.map(followupText)),
    evidence === "" ? "" : `<details><summary>Evidence</summary>${evidence}</details>`,
  ].join("");
}

function markdownComment(result: CaseResult): string {
  const evidence = [
    result.checks.length === 0
      ? ""
      : [
          "| Check | Expected | Observed | Result |",
          "| --- | --- | --- | --- |",
          ...result.checks.map(markdownRow),
        ].join("\n"),
    markdownList("Notes:", result.notes),
    result.attachments.length === 0 ? "" : `Attached files: ${escapeMarkdown(result.attachments.join(", "))}`,
  ].filter((block) => block !== "");
  return `${[
    `**${STATUS_LABELS[result.status]}** on ${escapeMarkdown(resultSubject(result))}`,
    result.reason === undefined ? "" : `Reason: ${escapeMarkdown(result.reason)}`,
    markdownList("Follow-up for a person:", result.followups.map(followupText)),
    ...(evidence.length === 0 ? [] : ["### Evidence", ...evidence]),
  ]
    .filter((block) => block !== "")
    .join("\n\n")}\n`;
}

function htmlRow(check: CheckRecord): string {
  const cells = [check.name, cellText(check.expected), cellText(check.observed), checkResult(check)];
  return `<tr>${cells.map((text) => `<td>${escapeHtml(text)}</td>`).join("")}</tr>`;
}

function htmlList(label: string, items: readonly string[]): string {
  if (items.length === 0) return "";
  return `<p>${label}</p><ul>${items.map((item) => `<li>${escapeHtml(item)}</li>`).join("")}</ul>`;
}

// the caption is the file name without its number and extension
function figure(name: string, ref: MediaRef): string {
  const caption = name
    .replace(/^\d+-/, "")
    .replace(/\.png$/, "")
    .replaceAll("-", " ");
  const collection = ref.collection === undefined ? "" : ` data-collection="${escapeHtml(ref.collection)}"`;
  const media = `<div data-type="media" data-media-type="file" data-id="${escapeHtml(ref.id)}"${collection} data-alt="${escapeHtml(name)}"></div>`;
  return `<figure data-type="media-single" data-layout="center" data-width="60" data-width-type="percentage">${media}<figcaption>${escapeHtml(caption)}</figcaption></figure>`;
}

function escapeHtml(text: string): string {
  return text
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function markdownRow(check: CheckRecord): string {
  const cells = [check.name, cellText(check.expected), cellText(check.observed), checkResult(check)];
  return `| ${cells.map(escapeMarkdown).join(" | ")} |`;
}

function markdownList(label: string, items: readonly string[]): string {
  if (items.length === 0) return "";
  return [label, "", ...items.map((item) => `- ${escapeMarkdown(item)}`)].join("\n");
}
