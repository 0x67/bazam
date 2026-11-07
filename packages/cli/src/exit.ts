import type { LoadIssue } from "@bazam/core/case";
import type { Status } from "@bazam/core/result";

export const ExitCode = { Pass: 0, Fail: 1, CouldNotStart: 2, Incomplete: 3 } as const;
export type ExitCode = (typeof ExitCode)[keyof typeof ExitCode];

/** 1 when any case failed, else 3 when any is blocked or needs follow-up, else 0. */
export function exitCodeFor(statuses: readonly Status[]): ExitCode {
  if (statuses.includes("fail")) return ExitCode.Fail;
  if (statuses.some((status) => status === "blocked" || status === "followup")) return ExitCode.Incomplete;
  return ExitCode.Pass;
}

/** Stops a command that cannot start or cannot do its work; main prints the message and the issues and exits 2. */
export class CommandError extends Error {
  readonly issues: readonly LoadIssue[];

  constructor(message: string, issues: readonly LoadIssue[] = []) {
    super(message);
    this.name = "CommandError";
    this.issues = issues;
  }
}
