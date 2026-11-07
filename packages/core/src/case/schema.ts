import { z } from "zod";

export const CASE_ID = /^[A-Z][A-Z0-9]*-[A-Z][A-Z0-9]*-\d{3,}$/;
export const Stage = z.enum(["draft", "acceptance", "regression", "retired"]);
export const TicketRef = z.string().regex(/^[a-z][a-z0-9-]*:[^\s]+$/, { error: 'a link looks like "jira:TD-246"' });

/** A step kind with its zod schema; a driver or plugin step handler satisfies it. */
export interface StepSchemaSource {
  kind: string;
  schema: z.ZodType;
}

/** One key names the step kind and holds its payload; `as` names the identity that runs the step. */
export interface Step {
  as?: string;
  [kind: string]: unknown;
}

/** A check is a step whose handler records a check result, such as `api`. */
export type CheckSpec = Step;

const IdentityName = z.string().min(1);

export const Selector = z.union([
  z.strictObject({ id: z.string().min(1) }),
  z.strictObject({ role: z.string().min(1), name: z.string().optional() }),
  z.strictObject({ text: z.string().min(1) }),
  z.strictObject({ css: z.string().min(1) }),
]);
export type Selector = z.infer<typeof Selector>;

const FlowParamValue = z.union([z.string(), z.number(), z.boolean()]);
export const UseStep = z.union([
  z.string().min(1),
  z.strictObject({ flow: z.string().min(1), with: z.record(z.string(), FlowParamValue).optional() }),
]);
export type UseStep = z.infer<typeof UseStep>;

export const RequestStep = z.strictObject({
  method: z.enum(["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"]),
  url: z.string().min(1),
  as: IdentityName.optional(),
  json: z.unknown().optional(),
  headers: z.record(z.string(), z.string()).optional(),
  write: z.boolean().optional(),
  save: z.record(z.string(), z.string()).optional(),
});
export type RequestStep = z.infer<typeof RequestStep>;

export interface ChallengeStep {
  kind: string;
  trigger?: Step;
  fill?: Selector;
  params?: Record<string, string>;
}

export interface GuidedStep {
  title: string;
  steps: string[];
  expected?: string;
  observe?: Step;
}

const ReportAction = z.strictObject({
  transition: z.string().min(1).optional(),
  mention: z
    .array(z.string().regex(/^role:[a-z][a-z0-9-]*$/, { error: 'a mention looks like "role:qa-lead"' }))
    .default([]),
});
export const ReportPolicy = z.strictObject({
  comment: z.enum(["new", "update"]).default("new"),
  on: z
    .strictObject({
      pass: ReportAction.optional(),
      fail: ReportAction.optional(),
      blocked: ReportAction.optional(),
      followup: ReportAction.optional(),
    })
    .default({}),
});
export type ReportPolicy = z.infer<typeof ReportPolicy>;

export type CaseSpec = {
  id: string;
  title: string;
  stage: z.infer<typeof Stage>;
  risk: "high" | "medium" | "low";
  links: string[];
  targets: string[];
  needs: string[];
  tags: string[];
  once: boolean;
  prod_safe: boolean;
  steps: Step[];
  checks: CheckSpec[];
  report?: ReportPolicy;
};

/** Returns the key that names the step kind. */
export function stepKind(step: Step): string {
  const kind = Object.keys(step).find((key) => key !== "as");
  if (kind === undefined) throw new Error("step has no kind key");
  return kind;
}

/**
 * Builds the schema for one step from the core kinds plus `sources`.
 * A source whose kind is a core kind replaces the core schema.
 */
export function buildStepSchema(sources: readonly StepSchemaSource[]): z.ZodType<Step> {
  const nested: z.ZodType<Step> = z.lazy(() => step);
  const payloads = new Map<string, z.ZodType>([
    ["use", UseStep],
    ["request", RequestStep],
    [
      "challenge",
      z.strictObject({
        kind: z.string().min(1),
        trigger: nested.optional(),
        fill: Selector.optional(),
        params: z.record(z.string(), z.string()).optional(),
      }),
    ],
    [
      "guided",
      z.strictObject({
        title: z.string().min(1),
        steps: z.array(z.string().min(1)).min(1),
        expected: z.string().min(1).optional(),
        observe: nested.optional(),
      }),
    ],
    ["note", z.string().min(1)],
  ]);
  for (const source of sources) payloads.set(source.kind, source.schema);

  const shapes = new Map(
    [...payloads].map(([kind, payload]) => [kind, z.strictObject({ [kind]: payload, as: IdentityName.optional() })]),
  );
  // The transform checks the step against its own kind alone, so issues point inside the payload.
  // The union then parses the same input and gives JSON Schema its anyOf.
  const step: z.ZodType<Step> = z
    .transform((input: unknown, ctx) => {
      const failure = stepShapeIssue(input, shapes);
      if (failure !== undefined) {
        ctx.issues.push({ code: "custom", input, ...failure });
        return z.NEVER;
      }
      const result = shapes.get(stepKind(input as Step))!.safeParse(input);
      if (!result.success) {
        ctx.issues.push(...result.error.issues.map((issue) => stepIssue(issue, input)));
        return z.NEVER;
      }
      return input;
    })
    .pipe(z.union([...shapes.values()])) as z.ZodType<Step>;
  return step;
}

// The pipe goes on past unrecognized_keys issues, so they come back as custom issues on the key.
function stepIssue(issue: z.core.$ZodIssue, input: unknown): z.core.$ZodRawIssue {
  if (issue.code !== "unrecognized_keys") return { ...issue, input } as z.core.$ZodRawIssue;
  return { code: "custom", input, message: issue.message, path: [...issue.path, ...issue.keys.slice(0, 1)] };
}

function stepShapeIssue(
  input: unknown,
  shapes: ReadonlyMap<string, z.ZodType>,
): { message: string; path?: string[] } | undefined {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    return { message: "a step is a mapping with one kind key, such as `note: text`" };
  }
  const kinds = Object.keys(input).filter((key) => key !== "as");
  if (kinds.length !== 1) {
    return { message: `a step has exactly one kind key, found ${kinds.length === 0 ? "none" : kinds.join(", ")}` };
  }
  const kind = kinds[0]!;
  if (shapes.has(kind)) return undefined;
  return { message: `unknown step kind "${kind}"; known kinds: ${[...shapes.keys()].sort().join(", ")}`, path: [kind] };
}

export function buildCaseSchema(steps: readonly StepSchemaSource[]): z.ZodType<CaseSpec> {
  const step = buildStepSchema(steps);
  return z.strictObject({
    id: z.string().regex(CASE_ID, { error: "an id looks like DOMAIN-AREA-NNN, for example AUTH-LOGIN-001" }),
    title: z.string().min(1),
    stage: Stage,
    risk: z.enum(["high", "medium", "low"]),
    links: z.array(TicketRef).default([]),
    targets: z.array(z.string().min(1)).min(1),
    needs: z.array(z.string().min(1)).default([]),
    tags: z.array(z.string().min(1)).default([]),
    once: z.boolean().default(false),
    prod_safe: z.boolean().default(false),
    steps: z.array(step).default([]),
    checks: z.array(step).default([]),
    report: ReportPolicy.optional(),
  }) as z.ZodType<CaseSpec>;
}

/** Core steps only, for tooling that runs without plugins. */
export const CaseSpec: z.ZodType<CaseSpec> = buildCaseSchema([]);

/** JSON Schema for a case file, a mapping with a `cases` list, as authors write it. */
export function caseJsonSchema(schema: z.ZodType<CaseSpec>): object {
  return z.toJSONSchema(z.strictObject({ cases: z.array(schema) }), { io: "input" });
}
