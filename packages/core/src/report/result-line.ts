import type { CaseResult, Status } from "../result/index.ts";

/** The first line of a comment when a tracker sets no template. */
export const DEFAULT_RESULT_LINE = "{status} on {env}: {case} {title} (run {run})";

export const RESULT_LINE_FIELDS = [
  "status",
  "env",
  "date",
  "identities",
  "case",
  "title",
  "run",
  "target",
] as const;

/** What is wrong with a template, or undefined: an unknown field, or a brace that belongs to no field. */
export function resultLineProblem(template: string): string | undefined {
  for (const [, name] of template.matchAll(/\{([^{}]*)\}/g)) {
    if (!(RESULT_LINE_FIELDS as readonly string[]).includes(name!)) {
      return `unknown field {${name}}; the fields are ${RESULT_LINE_FIELDS.join(", ")}`;
    }
  }
  if (/[{}]/.test(template.replace(/\{[^{}]*\}/g, ""))) {
    return "a { or } that is not part of a field";
  }
  return undefined;
}

/** The line in pieces, so a renderer escapes the text and makes the status bold. */
export type ResultLinePart = { text: string } | { status: Status };

/** Splits a template at its fields; the text parts hold the other fields' values joined with the literal text. */
export function resultLineParts(template: string, result: CaseResult): ResultLinePart[] {
  const parts: ResultLinePart[] = [];
  const addText = (text: string): void => {
    const last = parts.at(-1);
    if (last !== undefined && "text" in last) last.text += text;
    else if (text !== "") parts.push({ text });
  };
  template.split(/(\{[^{}]*\})/).forEach((piece, index) => {
    if (index % 2 === 0) addText(piece);
    else if (piece === "{status}") parts.push({ status: result.status });
    else addText(fieldValue(piece.slice(1, -1), result));
  });
  return parts;
}

function fieldValue(field: string, result: CaseResult): string {
  switch (field) {
    case "env":
      return result.env;
    case "date":
      return result.finishedAt.slice(0, 10);
    case "identities":
      return result.identities.length === 0 ? "nobody" : result.identities.join(", ");
    case "case":
      return result.caseId;
    case "title":
      return result.title;
    case "run":
      return result.runId;
    case "target":
      return result.target;
    default:
      return "";
  }
}
