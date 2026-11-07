import { describe, expect, it } from "vite-plus/test";
import { deriveReason, deriveStatus, type CaseOutcome, type CheckRecord, type Status } from "../src/result/index.ts";

const passed: CheckRecord = { name: "dashboard heading", kind: "ui", expected: "Dashboard", observed: "Dashboard", ok: true };
const failed: CheckRecord = { name: "refund fee", kind: "api", expected: 2, observed: 0, ok: false };
const toConfirm: CheckRecord = {
  name: "welcome email arrives",
  kind: "followup",
  expected: "checked by a person",
  observed: "not automated",
  ok: true,
  hint: "check the ops@example.test inbox",
};

const completed: CaseOutcome = { kind: "completed" };
const blocked: CaseOutcome = { kind: "blocked", reason: "identity admin-1 has no session" };
const harnessError: CaseOutcome = { kind: "errored", message: "step handler threw", source: "harness" };
const productError: CaseOutcome = { kind: "errored", message: "step 3 timed out after 30000 ms", source: "product" };

describe("deriveStatus", () => {
  it.each<[string, CheckRecord[], CaseOutcome, Status, string | undefined]>([
    ["fails a case with a failed check even when it was also blocked", [passed, failed], blocked, "fail", "identity admin-1 has no session"],
    ["blocks a blocked case that recorded no checks", [], blocked, "blocked", "identity admin-1 has no session"],
    ["maps a harness error to blocked with internal:", [], harnessError, "blocked", "internal: step handler threw"],
    ["fails a case the product errored in after passing checks", [passed], productError, "fail", "step 3 timed out after 30000 ms"],
    ["fails a case with no checks", [], completed, "fail", "no checks recorded"],
    ["gives followup when every check passed and a person still has to confirm one", [passed, toConfirm], completed, "followup", undefined],
    ["passes a completed case whose checks all passed", [passed], completed, "pass", undefined],
  ])("%s", (_name, checks, outcome, status, reason) => {
    expect(deriveStatus(checks, outcome)).toBe(status);
    expect(deriveReason(checks, outcome)).toBe(reason);
  });
});
