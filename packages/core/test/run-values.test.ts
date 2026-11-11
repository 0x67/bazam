import { describe, expect, it } from "vite-plus/test";
import { RunValues, UnresolvedPlaceholder, type CaseRunValues } from "../src/env/index.ts";
import { Redactor, defaultRedactionRules } from "../src/redact/index.ts";

const RUN_ID = "20261106-101530-a1b2";
const STARTED_AT = new Date("2026-11-06T10:15:30.123Z");

function runValues(seed: number): RunValues {
  return new RunValues(RUN_ID, STARTED_AT, seed);
}

function draws(values: CaseRunValues): string[] {
  return [
    values.value("random(1, 9, 2)"),
    values.value("random(100, 999, 0)"),
    values.value("random(-1.5, 1.5, 3)"),
  ];
}

describe("RunValues", () => {
  it("same seed and case id give the same values whatever the selection", () => {
    const alone = runValues(42);
    const withOthers = runValues(42);
    draws(withOthers.forCase("PAY-ORDER-001"));

    const expected = draws(alone.forCase("PAY-ORDER-002"));

    expect(draws(withOthers.forCase("PAY-ORDER-002"))).toEqual(expected);
    expect(draws(runValues(43).forCase("PAY-ORDER-002"))).not.toEqual(expected);
  });

  it("gives the same value for the same expression within a case, spacing aside, and records it", () => {
    const values = runValues(7).forCase("PAY-ORDER-001");
    const amount = values.value("random(1, 9, 2)");

    expect(values.value("random(1,9,2)")).toBe(amount);
    expect(values.value("id")).toBe(RUN_ID);
    expect(values.recorded()).toEqual({ "random(1, 9, 2)": amount, id: RUN_ID });
  });

  it("keeps random values within their bounds at the given number of decimals", () => {
    const run = runValues(1);
    for (let n = 0; n < 200; n++) {
      const values = run.forCase(`PAY-ORDER-${n}`);
      const amount = values.value("random(1.5, 2, 2)");
      const count = values.value("random(-3, 3, 0)");

      expect(amount).toMatch(/^\d\.\d{2}$/);
      expect(Number(amount)).toBeGreaterThanOrEqual(1.5);
      expect(Number(amount)).toBeLessThanOrEqual(2);
      expect(count).toMatch(/^-?\d$/);
      expect(Math.abs(Number(count))).toBeLessThanOrEqual(3);
    }
  });

  it("renders run.time with separators the redactor leaves readable", () => {
    const time = runValues(1).forCase("PAY-ORDER-001").value("time");

    expect(time).toBe("2026-11-06T10:15:30Z");
    expect(new Redactor(defaultRedactionRules()).text(time)).toBe(time);
  });

  it("throws UnresolvedPlaceholder for an unknown expression and for bounds it cannot draw from", () => {
    const values = runValues(1).forCase("PAY-ORDER-001");

    for (const expression of [
      "seed",
      "random(9, 1, 0)",
      "random(1, 9)",
      "random(1.555, 9, 2)",
      "random(1, 9, 400)",
    ]) {
      expect(() => values.value(expression)).toThrow(UnresolvedPlaceholder);
    }
    expect(values.recorded()).toEqual({});
  });
});
