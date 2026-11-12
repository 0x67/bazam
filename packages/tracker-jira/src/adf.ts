import type { JsonValue } from "@bazam/core/auth";
import {
  checkTable,
  DEFAULT_RESULT_LINE,
  resultLineParts,
  STATUS_LABELS,
} from "@bazam/core/report";
import type { CaseResult, CheckRecord } from "@bazam/core/result";

/** An Atlassian Document Format body; a type alias so it passes as a `JsonValue`. */
export type AdfDoc = { version: 1; type: "doc"; content: JsonValue[] };

// Jira refuses a body over 32,767 characters; the rest is room for mentions and masking
const MAX_DOC_LENGTH = 30_000;

/**
 * The comment in the order of the HTML comment, with the evidence under a level 3 heading and every attachment
 * named. Each value is a `text` node, so nothing from the app under test becomes markup. A document over 30,000
 * characters keeps the result line, the reason and the follow-ups, and a paragraph naming the run replaces the
 * evidence.
 */
export function renderJiraAdf(result: CaseResult, template = DEFAULT_RESULT_LINE): AdfDoc {
  const head: JsonValue[] = [
    {
      type: "paragraph",
      content: resultLineParts(template, result).flatMap((part) =>
        "status" in part
          ? [{ type: "text", text: STATUS_LABELS[part.status], marks: [{ type: "strong" }] }]
          : textNodes(part.text),
      ),
    },
    ...(result.reason === undefined ? [] : [paragraph(`Reason: ${result.reason}`)]),
    ...list("Follow-up for a person:", result.followups.map(followupText)),
  ];
  const evidence: JsonValue[] = [
    ...(result.checks.length === 0 ? [] : [checksTable(result.checks)]),
    ...list("Notes:", result.notes),
    ...(result.attachments.length === 0
      ? []
      : [paragraph(`Attached files: ${result.attachments.join(", ")}`)]),
  ];
  const full = doc([
    ...head,
    ...(evidence.length === 0
      ? []
      : [{ type: "heading", attrs: { level: 3 }, content: textNodes("Evidence") }]),
    ...evidence,
  ]);
  if (JSON.stringify(full).length <= MAX_DOC_LENGTH) return full;
  return doc([
    ...head,
    paragraph(`The evidence is too long for a Jira comment; it is in run ${result.runId}`),
  ]);
}

export function followupText(followup: CaseResult["followups"][number]): string {
  return followup.hint === "" ? followup.item : `${followup.item}: ${followup.hint}`;
}

export function checkResult(check: CheckRecord): string {
  if (check.kind === "followup") return "follow-up";
  return check.ok ? "ok" : "not ok";
}

function doc(content: JsonValue[]): AdfDoc {
  return { version: 1, type: "doc", content };
}

// ADF refuses an empty text node, so an empty value gives no node
function textNodes(text: string): JsonValue[] {
  return text === "" ? [] : [{ type: "text", text }];
}

function paragraph(text: string): JsonValue {
  return { type: "paragraph", content: textNodes(text) };
}

function list(label: string, items: readonly string[]): JsonValue[] {
  if (items.length === 0) return [];
  return [
    paragraph(label),
    {
      type: "bulletList",
      content: items.map((item) => ({ type: "listItem", content: [paragraph(item)] })),
    },
  ];
}

function checksTable(checks: readonly CheckRecord[]): JsonValue {
  const table = checkTable(checks, checkResult);
  const row = (type: string, cells: readonly string[]): JsonValue => ({
    type: "tableRow",
    content: cells.map((cell) => ({ type, content: [paragraph(cell)] })),
  });
  return {
    type: "table",
    content: [
      row("tableHeader", table.headers),
      ...table.rows.map((cells) => row("tableCell", cells)),
    ],
  };
}
