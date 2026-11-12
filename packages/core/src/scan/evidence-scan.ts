import { readFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { unzipSync } from "fflate";
import {
  defaultRedactionRules,
  EMAIL_ADDRESS,
  isTestEmailDomain,
  Redactor,
} from "../redact/index.ts";
import type { CaseResult } from "../result/index.ts";
import { RUN_ID, secretOf, unescaped, type Secret } from "./forms.ts";

export type FindingKind =
  | `fixture ${string}`
  | `secret ${string}`
  | `credential ${string}`
  | "email"
  | "digits";

export interface ScanValues {
  /** Each value to look for, with the kind it reports as. */
  values: readonly { kind: FindingKind; value: string }[];
  /** What could not be read, such as a secret no provider holds, for the scan's summary. */
  skipped: readonly string[];
  /** Epoch milliseconds that digit runs near it are read as times. */
  around: number;
}

export interface ScanFinding {
  kind: FindingKind;
  file: string;
  /** Up to 30 characters each side, with values replaced by their kind and digit runs by their length. */
  context: string;
}

export interface ScanReport {
  findings: ScanFinding[];
  files: number;
  skipped: readonly string[];
}

const CONTEXT_CHARS = 30;
const DAY_MS = 86_400_000;
const TIME_WINDOW_MS = 7 * DAY_MS;
// a number standing alone, not part of a hex id, a name or the fraction of a float
const DIGIT_RUN = /(?<![\p{L}\p{N}]|\p{N}\.)\d{8,}(?![\p{L}\p{N}]|\.\p{N})/gu;
const ZIP_MAGIC = [0x50, 0x4b, 0x03, 0x04];
// PNG and JPEG, the screenshots and screencast frames a run writes
const IMAGE_MAGIC = [
  [0x89, 0x50, 0x4e, 0x47],
  [0xff, 0xd8, 0xff],
];
// the evidence store writes these result.json fields unmasked, since the harness makes them
// (see packages/core/src/result/evidence.ts::EvidenceStore.finish)
const HARNESS_FIELDS = ["seed", "values", "steps", "durationMs"];
const VALUE_KINDS = ["fixture ", "secret ", "credential "];

interface Mark {
  start: number;
  end: number;
  kind: FindingKind;
  /** What the context shows in place of the match. */
  shown: string;
}

/** Scans the files, relative to runDir, and the text entries of the zips among them; png files are skipped. */
export async function scanFiles(
  runDir: string,
  files: readonly string[],
  values: ScanValues,
): Promise<ScanReport> {
  // a value the marks miss, such as a short one behind an escape, is still masked in a context
  const redactor = new Redactor(defaultRedactionRules());
  for (const { value } of values.values) {
    redactor.register(value);
    redactor.register(JSON.stringify(value).slice(1, -1));
  }
  const scan = { secrets: secretsOf(values), around: values.around, redactor };
  const findings: ScanFinding[] = [];
  const skipped = [...values.skipped];
  let scanned = 0;
  for (const file of files) {
    const bytes = new Uint8Array(await readFile(join(runDir, file)));
    if (IMAGE_MAGIC.some((magic) => startsWith(bytes, magic))) continue;
    scanned++;
    findings.push(...scanBytes(file, bytes, scan, skipped));
  }
  return { findings, files: scanned, skipped };
}

/** The attachments of the results that hold a fixture, secret or credential value, with those kinds. */
export async function withheldAttachments(
  runDir: string,
  results: readonly CaseResult[],
  values: ScanValues,
): Promise<ReadonlyMap<string, readonly string[]>> {
  const withheld = new Map<string, readonly string[]>();
  for (const result of results) {
    for (const name of result.attachments) {
      const attachment = `${result.caseId}/${name}`;
      const { findings } = await scanFiles(runDir, [attachment], values);
      const kinds = [...new Set(findings.map((finding) => finding.kind))].filter((kind) =>
        VALUE_KINDS.some((prefix) => kind.startsWith(prefix)),
      );
      if (kinds.length > 0) withheld.set(attachment, kinds.toSorted());
    }
  }
  return withheld;
}

interface Scan {
  secrets: readonly Secret[];
  around: number;
  redactor: Redactor;
}

function secretsOf(values: ScanValues): Secret[] {
  const byKind = new Map<FindingKind, string[]>();
  for (const { kind, value } of values.values)
    byKind.set(kind, [...(byKind.get(kind) ?? []), value]);
  // the JSON-escaped form too, so a context never shows a value the way a log wrote it
  return [...byKind].map(([kind, forms]) =>
    secretOf(kind, [...forms, ...forms.map((form) => JSON.stringify(form).slice(1, -1))]),
  );
}

/** The entries of a zip by name; throws on bytes that are not a readable zip. */
export function unzipEntries(bytes: Uint8Array): Record<string, Uint8Array> {
  return unzipSync(bytes);
}

function scanBytes(name: string, bytes: Uint8Array, scan: Scan, skipped: string[]): ScanFinding[] {
  if (startsWith(bytes, ZIP_MAGIC)) {
    let entries: Record<string, Uint8Array>;
    try {
      entries = unzipEntries(bytes);
    } catch {
      skipped.push(`${name} is not a readable zip`);
      return [];
    }
    return Object.entries(entries).flatMap(([entry, data]) =>
      scanBytes(`${name}:${entry}`, data, scan, skipped),
    );
  }
  if (IMAGE_MAGIC.some((magic) => startsWith(bytes, magic))) return [];
  // bytes that are not UTF-8 read as U+FFFD, which joins no token
  const text = scannedText(name, new TextDecoder("utf-8").decode(bytes));
  return textFindings(text, scan).map((finding) => ({ ...finding, file: name }));
}

// a run id is generated, and its hex part can hold a short value by chance
function scannedText(name: string, text: string): string {
  return (basename(name) === "result.json" ? withoutHarnessFields(text) : text).replaceAll(
    RUN_ID,
    " ",
  );
}

function withoutHarnessFields(text: string): string {
  let result: unknown;
  try {
    result = JSON.parse(text);
  } catch {
    return text;
  }
  if (typeof result !== "object" || result === null || Array.isArray(result)) return text;
  const kept = Object.entries(result).filter(([key]) => !HARNESS_FIELDS.includes(key));
  return JSON.stringify(Object.fromEntries(kept));
}

function textFindings(text: string, scan: Scan): Omit<ScanFinding, "file">[] {
  const found = contexts(
    text,
    [...valueMarks(text, scan.secrets), ...likenessMarks(text, scan)],
    scan.redactor,
  );
  // a value behind JSON or percent escapes shows only once they are undone; a kind found as written is not repeated
  const seen = new Set(found.map((finding) => finding.kind));
  const plain = unescaped(text);
  if (plain === text) return found;
  const undone = contexts(plain, valueMarks(plain, scan.secrets), scan.redactor);
  return [...found, ...undone.filter((finding) => !seen.has(finding.kind))];
}

function valueMarks(text: string, secrets: readonly Secret[]): Mark[] {
  return secrets.flatMap((secret) => {
    const spans = [
      ...secret.long.flatMap((form) => [...text.matchAll(new RegExp(escapedRegExp(form), "g"))]),
      ...secret.short.flatMap((token) => [...text.matchAll(new RegExp(token.source, "gu"))]),
    ];
    return spans.map(({ 0: match, index }) => ({
      start: index,
      end: index + match.length,
      kind: secret.name as FindingKind,
      shown: `[${secret.name}]`,
    }));
  });
}

// emails and digit runs that no value already covers
function likenessMarks(text: string, scan: Scan): Mark[] {
  const covered: Mark[] = valueMarks(text, scan.secrets);
  const emails = [...text.matchAll(EMAIL_ADDRESS)]
    .filter((match) => !isTestEmailDomain(match[0].slice(match[0].indexOf("@") + 1)))
    .map((match): Mark => ({
      start: match.index,
      end: match.index + match[0].length,
      kind: "email",
      shown: match[0],
    }));
  const digits = [...text.matchAll(DIGIT_RUN)]
    .filter((match) => !isTime(match[0], scan.around))
    .map((match): Mark => ({
      start: match.index,
      end: match.index + match[0].length,
      kind: "digits",
      shown: `<${match[0].length} digits, ends ${match[0].slice(-4)}>`,
    }));
  const free = (mark: Mark, others: readonly Mark[]) =>
    others.every((other) => mark.end <= other.start || other.end <= mark.start);
  const keptEmails = emails.filter((mark) => free(mark, covered));
  return [...keptEmails, ...digits.filter((mark) => free(mark, covered) && free(mark, keptEmails))];
}

// an epoch time in seconds or milliseconds, or a YYYYMMDD date, within a week of the run's start
function isTime(run: string, around: number): boolean {
  if (run.length === 10) return Math.abs(Number(run) * 1000 - around) <= TIME_WINDOW_MS;
  if (run.length === 13) return Math.abs(Number(run) - around) <= TIME_WINDOW_MS;
  if (run.length !== 8) return false;
  const month = Number(run.slice(4, 6));
  const day = Number(run.slice(6));
  if (month < 1 || month > 12 || day < 1 || day > 31) return false;
  return (
    Math.abs(Date.UTC(Number(run.slice(0, 4)), month - 1, day) - around) <= TIME_WINDOW_MS + DAY_MS
  );
}

/** The text with each match shown as its mark says, and the stretch around each mark, through the redactor. */
function contexts(
  text: string,
  marks: readonly Mark[],
  redactor: Redactor,
): Omit<ScanFinding, "file">[] {
  let shown = "";
  let cursor = 0;
  // where each mark sits in the shown text; a mark inside an earlier one shares its place
  const places = new Map<Mark, [number, number]>();
  let cover: { end: number; place: [number, number] } | undefined;
  for (const mark of marks.toSorted((a, b) => a.start - b.start || b.end - a.end)) {
    if (cover !== undefined && mark.start < cover.end) {
      places.set(mark, cover.place);
      // a mark that runs past the cover is replaced with it, so its tail is not copied raw
      if (mark.end > cover.end) {
        cover.end = mark.end;
        cursor = mark.end;
      }
      continue;
    }
    shown += text.slice(cursor, mark.start);
    const place: [number, number] = [shown.length, shown.length + mark.shown.length];
    shown += mark.shown;
    cursor = mark.end;
    cover = { end: mark.end, place };
    places.set(mark, place);
  }
  shown += text.slice(cursor);
  const seen = new Set<string>();
  return marks.flatMap((mark) => {
    const [start, end] = places.get(mark) ?? [0, 0];
    const context = redactor
      .text(shown.slice(Math.max(0, start - CONTEXT_CHARS), end + CONTEXT_CHARS))
      .replace(/\s/g, " ");
    const id = `${mark.kind}\0${context}`;
    if (seen.has(id)) return [];
    seen.add(id);
    return [{ kind: mark.kind, context }];
  });
}

function escapedRegExp(text: string): string {
  return text.replace(/[\\^$.*+?()[\]{}|]/g, "\\$&");
}

function startsWith(bytes: Uint8Array, magic: readonly number[]): boolean {
  return magic.every((byte, index) => bytes[index] === byte);
}
