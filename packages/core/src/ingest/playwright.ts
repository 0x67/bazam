import { stripVTControlCharacters } from "node:util";
import { z } from "zod";
import { ResultParseError, type ExternalTest, type ResultFile, type ResultFormat, type TestOutcome } from "./format.ts";

// the parts of Playwright's JSONReport that become tests
const JsonResult = z.object({
  duration: z.number(),
  errors: z.array(z.object({ message: z.string() })),
  attachments: z.array(z.object({ name: z.string(), path: z.string().optional(), contentType: z.string() })),
});
const JsonTest = z.object({
  projectName: z.string(),
  expectedStatus: z.string(),
  status: z.enum(["expected", "unexpected", "flaky", "skipped"]),
  results: z.array(JsonResult),
});
type JsonTest = z.infer<typeof JsonTest>;
const JsonSpec = z.object({ title: z.string(), tags: z.array(z.string()), tests: z.array(JsonTest) });
const JsonSuite = z.object({
  title: z.string(),
  specs: z.array(JsonSpec),
  get suites() {
    return z.array(JsonSuite).optional();
  },
});
type JsonSuite = z.infer<typeof JsonSuite>;
const JsonReport = z.object({ suites: z.array(JsonSuite) });

const OUTCOMES = {
  expected: "passed",
  unexpected: "failed",
  flaky: "passed",
  skipped: "skipped",
} as const satisfies Record<JsonTest["status"], TestOutcome>;

/** The report of Playwright's `json` reporter. */
export const playwrightJsonFormat: ResultFormat = {
  name: "playwright-json",
  async parse(file) {
    const tests: ExternalTest[] = [];
    for (const suite of reportOf(file).suites) collect(suite, [], file.path, tests);
    return tests;
  },
};

function reportOf(file: ResultFile): z.infer<typeof JsonReport> {
  let data: unknown;
  try {
    data = JSON.parse(file.text);
  } catch (error) {
    if (!(error instanceof SyntaxError)) throw error;
    // V8's message may quote the file, so only its position is kept
    const position = / at position (\d+)/.exec(error.message)?.[1];
    const at = position === undefined ? "" : lineAndColumn(file.text, Number(position));
    throw new ResultParseError(`${file.path}: not valid JSON${at}`);
  }
  const report = JsonReport.safeParse(data);
  if (!report.success) throw new ResultParseError(`${file.path}: not a Playwright JSON report`);
  return report.data;
}

function lineAndColumn(text: string, position: number): string {
  const before = text.slice(0, position);
  return ` (line ${before.split("\n").length}, column ${position - before.lastIndexOf("\n")})`;
}

// a file's suite is titled with its path from rootDir, and each describe nests a suite inside it
function collect(suite: JsonSuite, parents: readonly string[], source: string, tests: ExternalTest[]): void {
  const titles = suite.title === "" ? parents : [...parents, suite.title];
  for (const spec of suite.specs) {
    for (const test of spec.tests) tests.push(testOf([...titles, spec.title], spec.tags, test, source));
  }
  for (const child of suite.suites ?? []) collect(child, titles, source, tests);
}

function testOf(title: readonly string[], tags: readonly string[], test: JsonTest, source: string): ExternalTest {
  const last = test.results.at(-1);
  const message = last?.errors[0]?.message;
  return {
    title,
    tags,
    outcome: test.status === "expected" && test.expectedStatus === "skipped" ? "skipped" : OUTCOMES[test.status],
    ...(message === undefined ? {} : { message: stripVTControlCharacters(message) }),
    retries: Math.max(test.results.length - 1, 0),
    ...(test.projectName === "" ? {} : { project: test.projectName }),
    ...(last === undefined ? {} : { durationMs: last.duration }),
    // inline attachments carry a body and no path
    attachments: (last?.attachments ?? []).flatMap(({ name, path, contentType }) =>
      path === undefined ? [] : [{ name, path, contentType }],
    ),
    source,
  };
}
