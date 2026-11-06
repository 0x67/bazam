import type { Project } from "../project.ts";

/** Same fields as case/load.ts::LoadIssue, so loader issues pass through as they are. */
export interface CheckIssue {
  ruleId: string;
  severity: "error" | "warning";
  /** Relative to the project root, with forward slashes. */
  file: string;
  line: number;
  message: string;
  fix: string;
}

export interface CheckRule {
  id: string;
  check(project: Project): CheckIssue[];
}

export function checkProject(project: Project, rules: readonly CheckRule[]): CheckIssue[] {
  return rules.flatMap((rule) => rule.check(project));
}
