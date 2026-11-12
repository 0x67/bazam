import { describe, expect, it } from "vite-plus/test";
import { cellText, checkTable } from "../src/report/index.ts";
import type { CheckRecord } from "../src/result/index.ts";

function check(fields: Partial<CheckRecord> = {}): CheckRecord {
  return { name: "balance", kind: "api", expected: "10", observed: "10", ok: true, ...fields };
}

const resultOf = (record: CheckRecord): string => (record.ok ? "ok" : "not ok");

describe("checkTable", () => {
  it("gives four headers when no check has a level", () => {
    const table = checkTable([check(), check({ name: "name", ok: false })], resultOf);

    expect(table.headers).toEqual(["Check", "Expected", "Observed", "Result"]);
    expect(table.rows).toEqual([
      ["balance", "10", "10", "ok"],
      ["name", "10", "10", "not ok"],
    ]);
  });

  it("gives five headers with Level before Result when one check has a level", () => {
    const table = checkTable([check({ level: "core" }), check({ name: "name" })], resultOf);

    expect(table.headers).toEqual(["Check", "Expected", "Observed", "Level", "Result"]);
    expect(table.rows).toEqual([
      ["balance", "10", "10", "core", "ok"],
      ["name", "10", "10", "", "ok"],
    ]);
  });

  it("takes the last cell from resultOf", () => {
    const table = checkTable([check({ kind: "followup" })], () => "follow-up");

    expect(table.rows[0]?.at(-1)).toBe("follow-up");
  });
});

describe("cellText", () => {
  it("keeps a string, writes other values as JSON and an undefined value as empty", () => {
    expect([cellText("a"), cellText({ a: 1 }), cellText(undefined)]).toEqual(["a", '{"a":1}', ""]);
  });
});
