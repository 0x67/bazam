export type TestOutcome = "passed" | "failed" | "errored" | "skipped";

/** One test of an external suite's report, as a result format reads it. */
export interface ExternalTest {
  /** Enclosing suites from the outside in, then the test's own name. */
  title: readonly string[];
  /** As the report gives them, such as Playwright JSON's "smoke", written without the @. */
  tags: readonly string[];
  outcome: TestOutcome;
  /** The first failure or error message. */
  message?: string;
  /** Runs before the one that decided the outcome. */
  retries: number;
  /** A Playwright project name. */
  project?: string;
  durationMs?: number;
  /** Paths as the report wrote them. */
  attachments: { name: string; path: string; contentType?: string }[];
  /** The result file it came from, which relative attachment paths may start from. */
  source: string;
}

export interface ResultFile {
  path: string;
  text: string;
}

/** Reads one result file; async so a process plugin's format fits the same type. */
export interface ResultFormat {
  name: string;
  parse(file: ResultFile): Promise<ExternalTest[]>;
}

/** A result file that does not parse; the message names the file and never quotes its text. */
export class ResultParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ResultParseError";
  }
}
