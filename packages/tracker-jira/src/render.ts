import {
  checkTable,
  DEFAULT_RESULT_LINE,
  escapeMarkdown,
  markdownResultLine,
  resultLineParts,
  STATUS_LABELS,
  type MediaRefs,
  type RenderOptions,
  type TrackerRenderer,
} from "@bazam/core/report";
import type { CaseResult } from "@bazam/core/result";
import { checkResult, followupText, renderJiraAdf, type AdfDoc } from "./adf.ts";

type MediaRef = MediaRefs[string];

/**
 * The comment opens with the result line (the tracker's template, or the default) and any reason, then follow-ups for a person, then the evidence.
 * The HTML folds the evidence and shows a screenshot inline when `media` holds its uploaded id.
 * Markdown has no fold or media embed (the Atlassian connector stores HTML tags in Markdown as
 * literal text), so its evidence goes under a heading and it lists every file by name. ADF, which
 * the Jira client posts, follows the Markdown in that.
 */
export function renderJiraComment(
  result: CaseResult,
  options: RenderOptions = {},
): { markdown: string; html: string; adf: AdfDoc } {
  return {
    markdown: markdownComment(result, options.resultLine),
    html: htmlComment(result, options.media ?? {}, options.resultLine),
    adf: renderJiraAdf(result, options.resultLine),
  };
}

export const jiraTracker: TrackerRenderer = { tracker: "jira", render: renderJiraComment };

function htmlComment(result: CaseResult, media: MediaRefs, template?: string): string {
  const figures: string[] = [];
  const listed: string[] = [];
  for (const name of result.attachments) {
    // media keys are paths relative to the run directory, as in PostPlanItem.attachments
    const ref = name.endsWith(".png") ? media[`${result.caseId}/${name}`] : undefined;
    if (ref === undefined) listed.push(name);
    else figures.push(figure(name, ref));
  }
  const table = checkTable(result.checks, checkResult);
  const htmlCells = (tag: string, cells: readonly string[]): string =>
    `<tr>${cells.map((text) => `<${tag}>${escapeHtml(text)}</${tag}>`).join("")}</tr>`;
  const evidence = [
    result.checks.length === 0
      ? ""
      : `<table><thead>${htmlCells("th", table.headers)}</thead><tbody>${table.rows.map((cells) => htmlCells("td", cells)).join("")}</tbody></table>`,
    htmlList("Notes:", result.notes),
    ...figures,
    listed.length === 0 ? "" : `<p>Attached files: ${escapeHtml(listed.join(", "))}</p>`,
  ].join("");
  return [
    `<p>${htmlResultLine(result, template)}</p>`,
    result.reason === undefined ? "" : `<p>Reason: ${escapeHtml(result.reason)}</p>`,
    htmlList("Follow-up for a person:", result.followups.map(followupText)),
    evidence === "" ? "" : `<details><summary>Evidence</summary>${evidence}</details>`,
  ].join("");
}

function markdownComment(result: CaseResult, template?: string): string {
  const table = checkTable(result.checks, checkResult);
  const evidence = [
    result.checks.length === 0
      ? ""
      : [
          markdownRow(table.headers),
          `| ${table.headers.map(() => "---").join(" | ")} |`,
          ...table.rows.map(markdownRow),
        ].join("\n"),
    markdownList("Notes:", result.notes),
    result.attachments.length === 0
      ? ""
      : `Attached files: ${escapeMarkdown(result.attachments.join(", "))}`,
  ].filter((block) => block !== "");
  return `${[
    markdownResultLine(result, template),
    result.reason === undefined ? "" : `Reason: ${escapeMarkdown(result.reason)}`,
    markdownList("Follow-up for a person:", result.followups.map(followupText)),
    ...(evidence.length === 0 ? [] : ["### Evidence", ...evidence]),
  ]
    .filter((block) => block !== "")
    .join("\n\n")}\n`;
}

function htmlResultLine(result: CaseResult, template = DEFAULT_RESULT_LINE): string {
  return resultLineParts(template, result)
    .map((part) =>
      "status" in part ? `<strong>${STATUS_LABELS[part.status]}</strong>` : escapeHtml(part.text),
    )
    .join("");
}

function htmlList(label: string, items: readonly string[]): string {
  if (items.length === 0) return "";
  return `<p>${label}</p><ul>${items.map((item) => `<li>${escapeHtml(item)}</li>`).join("")}</ul>`;
}

// the caption is the file name without its leading number and extension, with dashes as spaces
function figure(name: string, ref: MediaRef): string {
  const caption = name
    .replace(/^\d+-/, "")
    .replace(/\.png$/, "")
    .replaceAll("-", " ");
  const collection =
    ref.collection === undefined ? "" : ` data-collection="${escapeHtml(ref.collection)}"`;
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

function markdownRow(cells: readonly string[]): string {
  return `| ${cells.map(escapeMarkdown).join(" | ")} |`;
}

function markdownList(label: string, items: readonly string[]): string {
  if (items.length === 0) return "";
  return [label, "", ...items.map((item) => `- ${escapeMarkdown(item)}`)].join("\n");
}
