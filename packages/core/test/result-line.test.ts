import { describe, expect, it } from "vite-plus/test";
import {
  DEFAULT_RESULT_LINE,
  RESULT_LINE_FIELDS,
  resultLineParts,
  resultLineProblem,
} from "../src/report/index.ts";
import type { CaseResult } from "../src/result/index.ts";

const RESULT: CaseResult = {
  runId: "20261110-090000-ab12",
  caseId: "AUTH-LOGIN-001",
  title: "Customer signs in",
  stage: "acceptance",
  env: "uat",
  target: "web",
  links: [],
  status: "pass",
  checks: [],
  notes: [],
  callouts: [],
  followups: [],
  attachments: [],
  challenges: [],
  identities: ["alice", "ops"],
  seed: 7,
  values: {},
  caseValues: {},
  steps: [],
  startedAt: "2026-11-10T23:58:00.000Z",
  finishedAt: "2026-11-10T23:59:30.000Z",
  durationMs: 90_000,
};

describe("resultLineProblem", () => {
  it("accepts the default template and every field", () => {
    expect(resultLineProblem(DEFAULT_RESULT_LINE)).toBeUndefined();
    expect(resultLineProblem(RESULT_LINE_FIELDS.map((field) => `{${field}}`).join(" "))).toBe(
      undefined,
    );
  });

  it("names an unknown field and lists the fields", () => {
    expect(resultLineProblem("{status} on {enviroment}")).toBe(
      "unknown field {enviroment}; the fields are status, env, date, identities, case, title, run, target",
    );
  });

  it("names a lone { and a lone }", () => {
    expect(resultLineProblem("{status} on {env")).toBe("a { or } that is not part of a field");
    expect(resultLineProblem("status} on {env}")).toBe("a { or } that is not part of a field");
    expect(resultLineProblem("{{env}")).toBe("a { or } that is not part of a field");
  });
});

describe("resultLineParts", () => {
  it("fills every field and keeps the status as its own part", () => {
    const template = RESULT_LINE_FIELDS.map((field) => `{${field}}`).join("|");

    expect(resultLineParts(template, RESULT)).toEqual([
      { status: "pass" },
      {
        text: "|uat|2026-11-10|alice, ops|AUTH-LOGIN-001|Customer signs in|20261110-090000-ab12|web",
      },
    ]);
  });

  it("writes nobody for no identities and takes the date from finishedAt in UTC", () => {
    const parts = resultLineParts("{date} as {identities}", {
      ...RESULT,
      identities: [],
      finishedAt: "2026-11-11T00:00:01.000Z",
    });

    expect(parts).toEqual([{ text: "2026-11-11 as nobody" }]);
  });

  it("gives the text of today's line with the default template", () => {
    const parts = resultLineParts(DEFAULT_RESULT_LINE, RESULT);

    expect(parts).toEqual([
      { status: "pass" },
      { text: " on uat: AUTH-LOGIN-001 Customer signs in (run 20261110-090000-ab12)" },
    ]);
  });

  it("keeps a status in the middle of the line", () => {
    expect(resultLineParts("{env} {date}: {status} (as {identities})", RESULT)).toEqual([
      { text: "uat 2026-11-10: " },
      { status: "pass" },
      { text: " (as alice, ops)" },
    ]);
  });
});
