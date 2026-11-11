import { basename } from "node:path";
import { stripVTControlCharacters } from "node:util";
import { parseXml, XmlElement, XmlError } from "@rgrove/parse-xml";
import {
  ResultParseError,
  type ExternalTest,
  type ResultFile,
  type ResultFormat,
  type TestOutcome,
} from "./format.ts";

const OUTCOME_CHILDREN: readonly (readonly [string, TestOutcome])[] = [
  ["failure", "failed"],
  ["error", "errored"],
  ["skipped", "skipped"],
];
// Katalon marks the outcome with a status attribute and no child
const STATUS_OUTCOMES = new Map<string, TestOutcome>([
  ["FAILED", "failed"],
  ["ERROR", "errored"],
  ["SKIPPED", "skipped"],
]);
// Surefire and Playwright write one for each earlier run
const RERUN_CHILDREN = new Set(["flakyFailure", "flakyError", "rerunFailure", "rerunError"]);
const ATTACHMENT_LINE = /^\[\[ATTACHMENT\|(.+)\]\]$/;
const CHARACTER_REFERENCE = /&#(?:x([0-9A-Fa-f]+)|([0-9]+));/g;

/** JUnit XML as Surefire, pytest, Playwright, `mocha-junit-reporter` and Node's test runner write it. */
export const junitFormat: ResultFormat = {
  name: "junit",
  async parse(file) {
    const root = rootOf(file);
    const tests: ExternalTest[] = [];
    collect(root, root.name === "testsuite" ? withName([], root) : [], file.path, tests);
    return tests;
  },
};

function rootOf(file: ResultFile): XmlElement {
  let root: XmlElement | null;
  try {
    root = parseXml(xmlText(file.text), { ignoreUndefinedEntities: true }).root;
  } catch (error) {
    if (!(error instanceof XmlError)) throw error;
    // the first line ends with the position; the lines after it quote the file
    const reason = (error.message.split("\n", 1)[0] ?? "").replace(
      / \(line \d+, column \d+\)$/,
      "",
    );
    throw new ResultParseError(
      `${file.path}: ${reason} (line ${error.line}, column ${error.column})`,
    );
  }
  if (root?.name !== "testsuites" && root?.name !== "testsuite") {
    throw new ResultParseError(
      `${file.path}: the root element is neither testsuites nor testsuite`,
    );
  }
  return root;
}

// Node's reporter writes ANSI codes and other control characters raw, and the parser refuses them
function xmlText(raw: string): string {
  const text = stripVTControlCharacters(raw);
  let kept = "";
  let start = 0;
  for (let index = 0; index < text.length; index += 1) {
    if (forbidden(text.charCodeAt(index))) {
      kept += text.slice(start, index);
      start = index + 1;
    }
  }
  return (kept + text.slice(start)).replace(
    CHARACTER_REFERENCE,
    (reference: string, hex?: string, decimal?: string) =>
      forbidden(hex === undefined ? Number(decimal) : Number.parseInt(hex, 16)) ? "" : reference,
  );
}

// C0 controls other than tab, line feed and carriage return, plus U+FFFE and U+FFFF
function forbidden(code: number): boolean {
  return (
    (code < 0x20 && code !== 0x09 && code !== 0x0a && code !== 0x0d) ||
    code === 0xfffe ||
    code === 0xffff
  );
}

function collect(
  parent: XmlElement,
  suites: readonly string[],
  source: string,
  tests: ExternalTest[],
): void {
  for (const child of elements(parent)) {
    if (child.name === "testcase") tests.push(testOf(child, suites, source));
    else
      collect(child, child.name === "testsuite" ? withName(suites, child) : suites, source, tests);
  }
}

function withName(suites: readonly string[], suite: XmlElement): readonly string[] {
  const name = suite.attributes.name;
  return name ? [...suites, name] : suites;
}

function elements(parent: XmlElement): XmlElement[] {
  return parent.children.filter((child) => child instanceof XmlElement);
}

function testOf(testcase: XmlElement, suites: readonly string[], source: string): ExternalTest {
  const children = elements(testcase);
  const seconds = Number.parseFloat(testcase.attributes.time ?? "");
  return {
    title: titleOf(testcase, suites),
    tags: [],
    ...outcomeOf(testcase, children),
    retries: children.filter((child) => RERUN_CHILDREN.has(child.name)).length,
    ...(Number.isFinite(seconds) ? { durationMs: Math.round(seconds * 1000) } : {}),
    attachments: children
      .filter((child) => child.name === "system-out" || child.name === "system-err")
      .flatMap((output) => attachmentsIn(output.text)),
    source,
  };
}

function titleOf(testcase: XmlElement, suites: readonly string[]): string[] {
  const name = testcase.attributes.name ?? "";
  const classname = testcase.attributes.classname ?? "";
  // Node's reporter gives every test the classname "test", so the enclosing suites name it
  if (classname === "" || classname === "test") return [...suites, name];
  // mocha-junit-reporter writes the full title as name and the test's own title as classname
  if (name.endsWith(classname)) return [name];
  return [classname, name];
}

function outcomeOf(
  testcase: XmlElement,
  children: readonly XmlElement[],
): Pick<ExternalTest, "outcome" | "message"> {
  for (const [name, outcome] of OUTCOME_CHILDREN) {
    const child = children.find((element) => element.name === name);
    if (child === undefined) continue;
    const message =
      outcome === "skipped" ? undefined : child.attributes.message || firstLine(child.text);
    return message ? { outcome, message } : { outcome };
  }
  return { outcome: STATUS_OUTCOMES.get(testcase.attributes.status ?? "") ?? "passed" };
}

function firstLine(text: string): string | undefined {
  return text.trim().split(/\r?\n/, 1)[0];
}

// the Jenkins attachments convention: a line that holds only [[ATTACHMENT|<path>]]
function attachmentsIn(output: string): ExternalTest["attachments"] {
  return output.split(/\r?\n/).flatMap((line) => {
    const path = ATTACHMENT_LINE.exec(line.trim())?.[1]?.trim();
    return path ? [{ name: basename(path), path }] : [];
  });
}
