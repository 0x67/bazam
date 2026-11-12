import { describe, expect, it } from "vite-plus/test";
import { calloutsOf } from "../src/report/index.ts";
import type { CaseResult, CheckRecord } from "../src/result/index.ts";

function check(fields: Partial<CheckRecord>): CheckRecord {
  return { name: "balance", kind: "api", expected: "10", observed: "10", ok: true, ...fields };
}

function result(fields: Partial<CaseResult>): CaseResult {
  return { checks: [], callouts: [], followups: [], ...fields } as unknown as CaseResult;
}

describe("calloutsOf", () => {
  it("lists the notes first as errors, then the callout checks by outcome", () => {
    const callouts = calloutsOf(
      result({
        callouts: ["The mailbox stayed empty."],
        checks: [
          check({ name: "plain" }),
          check({
            name: "limit",
            expected: { max: 5 },
            observed: { max: 9 },
            ok: false,
            callout: true,
          }),
          check({ name: "balance", callout: true }),
        ],
      }),
    );

    expect(callouts).toEqual([
      { tone: "error", text: "The mailbox stayed empty." },
      { tone: "error", text: 'limit: expected {"max":5}, observed {"max":9}' },
      { tone: "success", text: "balance: expected 10, observed 10" },
    ]);
  });

  it("leaves out a follow-up record", () => {
    const followup = check({ name: "layout", kind: "followup", callout: true });

    expect(calloutsOf(result({ checks: [followup] }))).toEqual([]);
  });

  it("gives the check callouts only for a result written without the field", () => {
    const old = result({ checks: [check({ callout: true })] });
    delete (old as { callouts?: string[] }).callouts;

    expect(calloutsOf(old)).toEqual([
      { tone: "success", text: "balance: expected 10, observed 10" },
    ]);
  });
});
