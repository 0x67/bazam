import { describe, expect, it } from "vite-plus/test";
import { z } from "zod";
import { buildCaseSchema, CASE_ID, CaseSpec, caseJsonSchema } from "../src/case/index.ts";

const minimal = { id: "AUTH-LOGIN-001", title: "Customer signs in", stage: "draft", risk: "low", targets: ["web"] };

const tap = { kind: "tap", schema: z.strictObject({ id: z.string() }) };

function issuePaths(schema: z.ZodType, input: unknown): string[] {
  const result = schema.safeParse(input);
  return result.success ? [] : result.error.issues.map((issue) => issue.path.join("."));
}

function issueMessages(schema: z.ZodType, input: unknown): string[] {
  const result = schema.safeParse(input);
  return result.success ? [] : result.error.issues.map((issue) => issue.message);
}

describe("CaseSpec", () => {
  it("fills defaults for the optional list and flag fields", () => {
    expect(CaseSpec.parse(minimal)).toEqual({
      ...minimal,
      links: [],
      needs: [],
      tags: [],
      once: false,
      prod_safe: false,
      steps: [],
      checks: [],
    });
  });

  it("accepts every field with a valid value", () => {
    const full = {
      ...minimal,
      stage: "acceptance",
      risk: "high",
      links: ["jira:TD-246"],
      needs: ["passkey"],
      tags: ["smoke"],
      once: true,
      prod_safe: true,
      steps: [
        { use: "login" },
        { request: { method: "POST", url: "${env.API_URL}/orders", as: "customer", json: { amount: 1 }, write: true, save: { orderId: "body.id" } } },
        { challenge: { kind: "otp-email", trigger: { note: "send" }, fill: { id: "otp-input" }, params: { recipient: "a@example.test" } }, as: "customer" },
        { guided: { title: "Confirm with face", steps: ["Look at the camera"], expected: "Dashboard", observe: { note: "check" } } },
        { note: "done" },
      ],
      checks: [{ request: { method: "GET", url: "${env.API_URL}/me" } }],
      report: { comment: "update", on: { pass: { transition: "Ready for Release", mention: ["role:qa-lead"] } } },
    };

    expect(CaseSpec.safeParse(full).success).toBe(true);
  });

  it.each([
    ["id", "auth-login-1"],
    ["title", ""],
    ["stage", "done"],
    ["risk", "critical"],
    ["links", ["TD-246"]],
    ["targets", []],
    ["needs", [1]],
    ["tags", "smoke"],
    ["once", "yes"],
    ["prod_safe", 1],
    ["steps", "open the app"],
    ["checks", {}],
    ["report", { comment: "edit" }],
  ])("rejects an invalid %s with an issue on that field", (field, value) => {
    expect(issuePaths(CaseSpec, { ...minimal, [field]: value })[0]?.split(".")[0]).toBe(field);
  });

  it.each(["id", "title", "stage", "risk", "targets"])("rejects a case without %s", (field) => {
    const { [field as keyof typeof minimal]: _, ...rest } = minimal;

    expect(issuePaths(CaseSpec, rest)).toEqual([field]);
  });

  it("rejects an unknown case field", () => {
    expect(issueMessages(CaseSpec, { ...minimal, owner: "qa" })).toEqual(['Unrecognized key: "owner"']);
  });
});

describe("buildCaseSchema", () => {
  it("rejects an unknown step kind and lists the known kinds, plugin kinds included", () => {
    const schema = buildCaseSchema([tap]);

    expect(issuePaths(schema, { ...minimal, steps: [{ hover: { id: "menu" } }] })).toEqual(["steps.0.hover"]);
    expect(issueMessages(schema, { ...minimal, steps: [{ hover: { id: "menu" } }] })).toEqual([
      'unknown step kind "hover"; known kinds: challenge, guided, note, request, tap, use',
    ]);
  });

  it("accepts a plugin step kind with an identity", () => {
    const parsed = buildCaseSchema([tap]).parse({ ...minimal, steps: [{ tap: { id: "sign-in" }, as: "customer" }] });

    expect(parsed.steps).toEqual([{ tap: { id: "sign-in" }, as: "customer" }]);
  });

  it("lets a plugin schema replace the core schema of the same kind", () => {
    const schema = buildCaseSchema([{ kind: "note", schema: z.number() }]);

    expect(schema.safeParse({ ...minimal, steps: [{ note: 3 }] }).success).toBe(true);
    expect(schema.safeParse({ ...minimal, steps: [{ note: "text" }] }).success).toBe(false);
  });

  it("returns the plugin schema's output for its step", () => {
    const shout = { kind: "shout", schema: z.string().transform((text) => ({ text })) };

    expect(buildCaseSchema([shout]).parse({ ...minimal, steps: [{ shout: "hi" }] }).steps).toEqual([{ shout: { text: "hi" } }]);
  });

  it.each([
    ["two kind keys", { note: "a", request: { method: "GET", url: "u" } }, "a step has exactly one kind key, found note, request"],
    ["no kind key", { as: "customer" }, "a step has exactly one kind key, found none"],
    ["a plain string", "open the app", "a step is a mapping with one kind key, such as `note: text`"],
  ])("rejects a step with %s", (_, step, message) => {
    expect(issueMessages(CaseSpec, { ...minimal, steps: [step] })).toEqual([message]);
  });

  it("points issues inside a step at the payload field, also in nested trigger steps", () => {
    const steps = [
      { request: { method: "GET", url: 42 } },
      { request: { method: "GET", url: "u", body: "x" } },
      { challenge: { kind: "totp", trigger: { tap: { id: 7 } } } },
    ];

    expect(issuePaths(buildCaseSchema([tap]), { ...minimal, steps })).toEqual([
      "steps.0.request.url",
      "steps.1.request.body",
      "steps.2.challenge.trigger.tap.id",
    ]);
  });
});

describe("caseJsonSchema", () => {
  const json = caseJsonSchema(buildCaseSchema([tap])) as {
    properties: { cases: { items: { required: string[]; properties: Record<string, { pattern?: string }> } } };
    $defs: Record<string, { anyOf?: { required: string[] }[] }>;
  };
  const item = json.properties.cases.items;

  it("describes a case file whose cases require only the fields without defaults", () => {
    expect(item.required).toEqual(["id", "title", "stage", "risk", "targets"]);
    expect(item.properties["id"]?.pattern).toBe(CASE_ID.source);
  });

  it("lists every step kind, plugin kinds included, as one anyOf branch", () => {
    const stepBranches = Object.values(json.$defs).find((def) => def.anyOf !== undefined)?.anyOf ?? [];

    expect(stepBranches.map((branch) => branch.required).sort((a, b) => a.join().localeCompare(b.join()))).toEqual([
      ["challenge"],
      ["guided"],
      ["note"],
      ["request"],
      ["tap"],
      ["use"],
    ]);
  });
});
