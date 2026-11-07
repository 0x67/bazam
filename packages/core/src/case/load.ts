import { readdir, readFile } from "node:fs/promises";
import { join, posix } from "node:path";
import { isMap, isNode, isScalar, isSeq, LineCounter, parseDocument, type Document } from "yaml";
import { z } from "zod";
import { CASE_ID, type CaseSpec } from "./schema.ts";

export interface SourceSpan {
  file: string;
  line: number;
}

export interface LoadedCase {
  spec: CaseSpec;
  domain: string;
  source: SourceSpan;
}

/** Same fields as a check issue, so check can report load issues as they are. */
export interface LoadIssue {
  ruleId: string;
  severity: "error" | "warning";
  file: string;
  line: number;
  message: string;
  fix: string;
}

export interface CaseLoad {
  cases: LoadedCase[];
  retiredIds: ReadonlySet<string>;
  issues: LoadIssue[];
}

interface CaseFileRef {
  /** Relative to the project root, with forward slashes. */
  path: string;
  domain: string;
}

interface ParsedCase {
  id: string;
  idLine: number;
  domain: string;
  source: SourceSpan;
  /** Undefined when the case fails the schema; its id still goes through the id rules. */
  spec: CaseSpec | undefined;
}

const CaseFile = z.strictObject({ cases: z.array(z.unknown()) });

/**
 * Reads every `cases/<domain>/*.yaml` file under `root`. Cases with any issue are left out of `cases`.
 * A case that fails the schema still goes through the id rules, and the first case to use an id keeps it.
 */
export async function loadCases(root: string, schema: z.ZodType<CaseSpec>): Promise<CaseLoad> {
  const retiredIds = await readRetiredIds(root);
  const parsed: ParsedCase[] = [];
  const issues: LoadIssue[] = [];
  for (const file of await listCaseFiles(root)) {
    const text = await readFile(join(root, file.path), "utf8");
    const result = parseCaseFile(file, text, schema);
    parsed.push(...result.cases);
    issues.push(...result.issues);
  }
  const ids = checkIds(parsed, retiredIds);
  return { cases: ids.cases, retiredIds, issues: [...issues, ...ids.issues] };
}

async function readRetiredIds(root: string): Promise<ReadonlySet<string>> {
  let text: string;
  try {
    text = await readFile(join(root, "cases", ".retired"), "utf8");
  } catch (error) {
    if (isNotFound(error)) return new Set();
    throw error;
  }
  const lines = text.split(/\r?\n/).map((line) => line.trim());
  return new Set(lines.filter((line) => line !== "" && !line.startsWith("#")));
}

async function listCaseFiles(root: string): Promise<CaseFileRef[]> {
  let domains;
  try {
    domains = await readdir(join(root, "cases"), { withFileTypes: true });
  } catch (error) {
    if (isNotFound(error)) return [];
    throw error;
  }
  const files: CaseFileRef[] = [];
  for (const domain of domains.filter((entry) => entry.isDirectory() && !entry.name.startsWith(".")).sort(byName)) {
    const entries = await readdir(join(root, "cases", domain.name), { withFileTypes: true });
    for (const entry of entries.filter((e) => e.isFile() && e.name.endsWith(".yaml")).sort(byName)) {
      files.push({ path: posix.join("cases", domain.name, entry.name), domain: domain.name });
    }
  }
  return files;
}

function parseCaseFile(
  file: CaseFileRef,
  text: string,
  schema: z.ZodType<CaseSpec>,
): { cases: ParsedCase[]; issues: LoadIssue[] } {
  const lines = new LineCounter();
  const doc = parseDocument(text, { lineCounter: lines, prettyErrors: false });
  if (doc.errors.length > 0) {
    const issues = doc.errors.map((error) =>
      errorIssue({
        ruleId: "schema",
        file: file.path,
        line: lines.linePos(error.pos[0]).line,
        message: error.message,
        fix: "Fix the YAML syntax on this line.",
      }),
    );
    return { cases: [], issues };
  }
  const lineAt = (path: readonly PropertyKey[]) => lineOf(doc, path, lines);

  const shape = CaseFile.safeParse(doc.toJS());
  if (!shape.success) {
    return { cases: [], issues: shape.error.issues.map((issue) => schemaIssue(file, [], issue, lineAt)) };
  }
  const cases: ParsedCase[] = [];
  const issues: LoadIssue[] = [];
  shape.data.cases.forEach((item, index) => {
    const at = ["cases", index];
    const result = schema.safeParse(item);
    if (!result.success) issues.push(...result.error.issues.map((issue) => schemaIssue(file, at, issue, lineAt)));
    const id = result.success ? result.data.id : wellFormedId(item);
    if (id === undefined) return;
    cases.push({
      id,
      idLine: lineAt([...at, "id"]),
      domain: file.domain,
      source: { file: file.path, line: lineAt(at) },
      spec: result.success ? result.data : undefined,
    });
  });
  return { cases, issues };
}

function wellFormedId(item: unknown): string | undefined {
  if (typeof item !== "object" || item === null || !("id" in item)) return undefined;
  return typeof item.id === "string" && CASE_ID.test(item.id) ? item.id : undefined;
}

function schemaIssue(
  file: CaseFileRef,
  at: readonly PropertyKey[],
  issue: z.core.$ZodIssue,
  lineAt: (path: readonly PropertyKey[]) => number,
): LoadIssue {
  const path = issue.code === "unrecognized_keys" ? [...issue.path, ...issue.keys.slice(0, 1)] : issue.path;
  const line = lineAt([...at, ...path]);
  const where = formatPath(issue.path);
  const message = where === "" ? issue.message : `${where}: ${issue.message}`;
  if (at.length > 0 && issue.code === "invalid_format" && where === "id") {
    const fix = `Use an id such as ${file.domain.toUpperCase()}-LOGIN-001: domain, area, then three or more digits.`;
    return errorIssue({ ruleId: "id-format", file: file.path, line, message, fix });
  }
  return errorIssue({
    ruleId: "schema",
    file: file.path,
    line,
    message,
    fix: "Edit this entry so it matches the case schema.",
  });
}

function checkIds(
  parsed: readonly ParsedCase[],
  retiredIds: ReadonlySet<string>,
): { cases: LoadedCase[]; issues: LoadIssue[] } {
  const cases: LoadedCase[] = [];
  const issues: LoadIssue[] = [];
  const firstById = new Map<string, SourceSpan>();
  for (const { id, idLine, domain, source, spec } of parsed) {
    const file = source.file;
    if (retiredIds.has(id)) {
      const fix = "Pick a new id; ids in cases/.retired are never reused.";
      issues.push(errorIssue({ ruleId: "id-retired", file, line: idLine, message: `${id} is retired`, fix }));
      continue;
    }
    const first = firstById.get(id);
    if (first !== undefined) {
      const message = `${id} is already used at ${first.file}:${first.line}`;
      issues.push(
        errorIssue({
          ruleId: "id-unique",
          file,
          line: idLine,
          message,
          fix: "Give this case an id no other case uses.",
        }),
      );
      continue;
    }
    firstById.set(id, source);
    const domainPrefix = domain.toUpperCase();
    const prefix = id.split("-")[0]!;
    if (prefix !== domainPrefix) {
      const message = `${id} starts with ${prefix} but the case is in cases/${domain}/`;
      const fix = `Start the id with ${domainPrefix}- or move the case to cases/${prefix.toLowerCase()}/.`;
      issues.push(errorIssue({ ruleId: "id-domain", file, line: idLine, message, fix }));
      continue;
    }
    if (spec !== undefined) cases.push({ spec, domain, source });
  }
  return { cases, issues };
}

/** Line of the deepest node on `path`; a map entry counts from its key. */
function lineOf(doc: Document.Parsed, path: readonly PropertyKey[], lines: LineCounter): number {
  let node: unknown = doc.contents;
  let offset = startOf(node) ?? 0;
  for (const segment of path) {
    if (isMap(node)) {
      const pair = node.items.find((item) => isScalar(item.key) && String(item.key.value) === String(segment));
      if (pair === undefined) break;
      offset = startOf(pair.key) ?? offset;
      node = pair.value;
    } else if (isSeq(node) && typeof segment === "number" && segment < node.items.length) {
      node = node.items[segment];
      offset = startOf(node) ?? offset;
    } else {
      break;
    }
  }
  return lines.linePos(offset).line;
}

function startOf(node: unknown): number | undefined {
  return isNode(node) ? node.range?.[0] : undefined;
}

function formatPath(path: readonly PropertyKey[]): string {
  return path
    .map((segment, index) =>
      typeof segment === "number" ? `[${segment}]` : `${index === 0 ? "" : "."}${String(segment)}`,
    )
    .join("");
}

function errorIssue(fields: Omit<LoadIssue, "severity">): LoadIssue {
  return { ...fields, severity: "error" };
}

function byName(a: { name: string }, b: { name: string }): number {
  return a.name < b.name ? -1 : a.name > b.name ? 1 : 0;
}

function isNotFound(error: unknown): boolean {
  return (error as NodeJS.ErrnoException).code === "ENOENT";
}
