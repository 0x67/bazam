import type { CheckRecord } from "../result/index.ts";

export interface CheckTable {
  headers: readonly string[];
  rows: readonly (readonly string[])[];
}

/** The checks as table text: Check, Expected, Observed, Level when some check has one, Result. */
export function checkTable(
  checks: readonly CheckRecord[],
  resultOf: (check: CheckRecord) => string,
): CheckTable {
  const withLevel = checks.some((check) => check.level !== undefined);
  return {
    headers: ["Check", "Expected", "Observed", ...(withLevel ? ["Level"] : []), "Result"],
    rows: checks.map((check) => [
      check.name,
      cellText(check.expected),
      cellText(check.observed),
      ...(withLevel ? [check.level ?? ""] : []),
      resultOf(check),
    ]),
  };
}

/** A check's expected or observed value as table cell text: a string as it is, anything else as JSON. */
export function cellText(value: unknown): string {
  if (value === undefined) return "";
  return typeof value === "string" ? value : JSON.stringify(value);
}
