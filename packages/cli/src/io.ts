import type { LoadIssue } from "@bazam/core/case";
import type { Redactor } from "@bazam/core/redact";
import { CommandError } from "./exit.ts";

/** What a command reads and writes through: the bin passes the process's own, tests pass buffers. */
export interface CliIo {
  stdout: { write(text: string): unknown };
  stderr: { write(text: string): unknown };
  /** Path flags such as --root resolve against it. */
  cwd: string;
  /** Aborts on Ctrl-C in the bin; a run then ends its running cases and every later one blocked. */
  signal: AbortSignal;
}

/**
 * How much of a result the redactor masks: `all` masks it whole, `registered` masks only the values registered
 * with the redactor, for output the command masked field by field or that masking whole would break.
 */
export type Masking = "all" | "registered";

/** Writes a command's result to stdout and its logs to stderr, every line through the redactor. */
export class Output {
  readonly #io: CliIo;
  readonly #redactor: Redactor;
  readonly #json: boolean;

  constructor(io: CliIo, redactor: Redactor, json: boolean) {
    this.#io = io;
    this.#redactor = redactor;
    this.#json = json;
  }

  /** With --json, `doc` as the one JSON document on stdout; else `text`. */
  result(doc: unknown, text: string, masking: Masking = "all"): void {
    if (masking === "registered") {
      this.#io.stdout.write(this.#redactor.maskRegistered(this.#json ? jsonText(doc) : text));
      return;
    }
    this.#io.stdout.write(this.#json ? jsonText(this.#redactor.value(doc)) : this.#redactor.text(text));
  }

  log(line: string): void {
    this.#io.stderr.write(`${this.#redactor.text(line)}\n`);
  }

  /** The error and its issues go to stderr; with --json, stdout also gets them as the one document. */
  error(error: unknown): void {
    const message = error instanceof Error ? error.message : String(error);
    const issues = error instanceof CommandError ? error.issues : [];
    this.log([`error: ${message}`, ...issues.map(issueText)].join("\n"));
    if (this.#json) this.result({ error: message, ...(issues.length === 0 ? {} : { issues }) }, "");
  }
}

/** `file:line: severity rule-id: message`, then the fix on the next line, as check prints it. */
export function issueText(issue: LoadIssue): string {
  return `${issue.file}:${issue.line}: ${issue.severity} ${issue.ruleId}: ${issue.message}\n  fix: ${issue.fix}`;
}

/** "1 case", "2 cases". */
export function plural(n: number, noun: string): string {
  return `${n} ${noun}${n === 1 ? "" : "s"}`;
}

function jsonText(doc: unknown): string {
  return `${JSON.stringify(doc, null, 2)}\n`;
}
