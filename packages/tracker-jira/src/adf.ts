import type { JsonValue } from "@bazam/core/auth";
import {
  type Callout,
  calloutsOf,
  checkTable,
  DEFAULT_RESULT_LINE,
  resultLineParts,
  STATUS_LABELS,
  type UploadedMedia,
} from "@bazam/core/report";
import type { CaseResult, CheckRecord } from "@bazam/core/result";

/** An Atlassian Document Format body; a type alias so it passes as a `JsonValue`. */
export type AdfDoc = { version: 1; type: "doc"; content: JsonValue[] };

/** The text the files paragraph of the evidence starts with. */
export const ATTACHED_FILES_PREFIX = "Attached files: ";

// Jira refuses a body over 32,767 characters; the rest is room for mentions and masking
const MAX_DOC_LENGTH = 30_000;

// the over-limit document cuts each callout to this, and drops callouts past the total
const FALLBACK_CALLOUT_LENGTH = 2_000;
const FALLBACK_CALLOUTS_TOTAL = 15_000;

/**
 * The comment in the order of the HTML comment, with the callouts as panels and the evidence in an expand titled
 * Evidence, every attachment named. Each value is a `text` node, so nothing from the app under test becomes markup. A document over 30,000
 * characters keeps the result line, the reason, the callouts (cut short) and the follow-ups, and a paragraph naming the run replaces the
 * evidence.
 */
export function renderJiraAdf(result: CaseResult, template = DEFAULT_RESULT_LINE): AdfDoc {
  const callouts = calloutsOf(result);
  const headOf = (shown: Callout[]): JsonValue[] => [
    {
      type: "paragraph",
      content: resultLineParts(template, result).flatMap((part) =>
        "status" in part
          ? [{ type: "text", text: STATUS_LABELS[part.status], marks: [{ type: "strong" }] }]
          : textNodes(part.text),
      ),
    },
    ...(result.reason === undefined ? [] : [paragraph(`Reason: ${result.reason}`)]),
    ...shown.map((callout) => panel(callout.tone, callout.text)),
    ...list("Follow-up for a person:", result.followups.map(followupText)),
  ];
  const evidence: JsonValue[] = [
    ...(result.checks.length === 0 ? [] : [checksTable(result.checks)]),
    ...list("Notes:", result.notes),
    ...(result.attachments.length === 0
      ? []
      : [paragraph(`${ATTACHED_FILES_PREFIX}${result.attachments.join(", ")}`)]),
  ];
  const full = doc([
    ...headOf(callouts),
    ...(evidence.length === 0
      ? []
      : [{ type: "expand", attrs: { title: "Evidence" }, content: evidence }]),
  ]);
  if (JSON.stringify(full).length <= MAX_DOC_LENGTH) return full;
  return doc([
    ...headOf(shortCallouts(callouts)),
    paragraph(`The evidence is too long for a Jira comment; it is in run ${result.runId}`),
  ]);
}

function shortCallouts(callouts: Callout[]): Callout[] {
  const kept: Callout[] = [];
  let total = 0;
  for (const callout of callouts) {
    const text =
      callout.text.length > FALLBACK_CALLOUT_LENGTH
        ? `${callout.text.slice(0, FALLBACK_CALLOUT_LENGTH)}...`
        : callout.text;
    total += text.length;
    if (total > FALLBACK_CALLOUTS_TOTAL) break;
    kept.push({ ...callout, text });
  }
  return kept;
}

/**
 * The document with a mediaSingle for each png the evidence lists and `uploaded` names, placed before the files
 * paragraph, and those names taken off the list. Only the files paragraph, the last child of the expand, is read.
 * A document without them, or one that would pass 30,000 characters, comes back unchanged.
 */
export function withInlineMedia(document: AdfDoc, uploaded: UploadedMedia): AdfDoc {
  const index = document.content.findIndex((node) => at(node, "type") === "expand");
  const children = at(document.content[index], "content");
  if (!Array.isArray(children) || children.length === 0) return document;
  const last: unknown = children[children.length - 1];
  const text = at(last, "content", "0", "text");
  if (at(last, "type") !== "paragraph" || typeof text !== "string") return document;
  if (!text.startsWith(ATTACHED_FILES_PREFIX)) return document;

  const names = text.slice(ATTACHED_FILES_PREFIX.length).split(", ");
  const images = names.flatMap((name) => {
    const media = uploaded.get(name);
    return name.endsWith(".png") && media !== undefined ? [mediaSingle(name, media)] : [];
  });
  if (images.length === 0) return document;
  const listed = names.filter((name) => !(name.endsWith(".png") && uploaded.has(name)));

  const evidence = [
    ...children.slice(0, -1),
    ...images,
    ...(listed.length === 0 ? [] : [paragraph(`${ATTACHED_FILES_PREFIX}${listed.join(", ")}`)]),
  ] as JsonValue[];
  const content = document.content.map((node, place) =>
    place === index ? { ...(node as object), content: evidence } : node,
  ) as JsonValue[];
  const next = doc(content);
  return JSON.stringify(next).length <= MAX_DOC_LENGTH ? next : document;
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

function mediaSingle(
  name: string,
  media: { id: string; width?: number; height?: number },
): JsonValue {
  const { id, width, height } = media;
  return {
    type: "mediaSingle",
    // align-start puts the picture at the left edge, in line with the table above it
    attrs: { layout: "align-start" },
    content: [
      {
        type: "media",
        attrs: {
          id,
          type: "file",
          collection: "",
          alt: name,
          ...(width === undefined ? {} : { width }),
          ...(height === undefined ? {} : { height }),
        },
      },
    ],
  };
}

// the value at the key path, where an array index is a key too
function at(value: unknown, ...keys: string[]): unknown {
  let current = value;
  for (const key of keys) {
    if (typeof current !== "object" || current === null) return undefined;
    current = (current as Record<string, unknown>)[key];
  }
  return current;
}

function panel(tone: "error" | "success", text: string): JsonValue {
  return { type: "panel", attrs: { panelType: tone }, content: [paragraph(text)] };
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
