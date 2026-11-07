import { stepKind, type Step, type UseStep } from "./schema.ts";

export interface FlowSpec {
  name: string;
  params: string[];
  steps: Step[];
}

/** A flow reached again on the current expansion path. */
export class FlowCycle extends Error {
  /** Flow names from the case's `use` step to the repeated flow, which appears twice. */
  readonly path: string[];

  constructor(path: string[]) {
    super(`flow cycle: ${path.join(" -> ")}`);
    this.name = "FlowCycle";
    this.path = path;
  }
}

/** A `use` step names an unknown flow, or its parameters do not match what the flow declares. */
export class InvalidFlowUse extends Error {
  readonly flow: string;

  constructor(flow: string, detail: string) {
    super(`flow ${flow}: ${detail}`);
    this.name = "InvalidFlowUse";
    this.flow = flow;
  }
}

/** A `use` step in a challenge's `trigger` or a guided step's `observe` names a flow that does not expand to one step. */
export class NestedFlowNotOneStep extends InvalidFlowUse {
  constructor(flow: string, detail: string) {
    super(flow, detail);
    this.name = "NestedFlowNotOneStep";
  }
}

const PARAM_PLACEHOLDER = /\$\{param\.([^}]*)\}/g;
// the payload field of each step kind that holds one nested step
const NESTED_STEP_FIELDS: ReadonlyMap<string, string> = new Map([
  ["challenge", "trigger"],
  ["guided", "observe"],
]);

/**
 * Replaces each `use` step with its flow's steps, with `${param.X}` filled in.
 * A `use` step's `as` applies to the flow steps that name no identity, either as the step's `as`
 * or as an `as` in the step's payload, such as `request.as`.
 * A `use` step in a challenge's `trigger` or a guided step's `observe` stands for one step, so its flow must expand to one.
 */
export function expandFlows(steps: readonly Step[], flows: ReadonlyMap<string, FlowSpec>): Step[] {
  return expandSteps(steps, flows, []);
}

function expandSteps(steps: readonly Step[], flows: ReadonlyMap<string, FlowSpec>, path: readonly string[]): Step[] {
  return steps.flatMap((step) => (stepKind(step) === "use" ? expandUse(step, flows, path) : [expandNested(step, flows, path)]));
}

function expandNested(step: Step, flows: ReadonlyMap<string, FlowSpec>, path: readonly string[]): Step {
  const kind = stepKind(step);
  const field = NESTED_STEP_FIELDS.get(kind);
  const payload = step[kind];
  if (field === undefined || typeof payload !== "object" || payload === null) return step;
  const nested = (payload as Record<string, unknown>)[field] as Step | undefined;
  if (nested === undefined) return step;
  const expanded = expandSteps([nested], flows, path);
  const [only] = expanded;
  // only a use step expands to a count other than one
  if (only === undefined || expanded.length > 1) {
    throw new NestedFlowNotOneStep(flowName(nested["use"] as UseStep), `a ${kind} ${field} runs one step, and the flow expands to ${expanded.length}`);
  }
  return only === nested ? step : { ...step, [kind]: { ...payload, [field]: only } };
}

function flowName(use: UseStep): string {
  return typeof use === "string" ? use : use.flow;
}

function expandUse(step: Step, flows: ReadonlyMap<string, FlowSpec>, path: readonly string[]): Step[] {
  const use = step["use"] as UseStep;
  const name = flowName(use);
  const flowPath = [...path, name];
  if (path.includes(name)) throw new FlowCycle(flowPath);
  const flow = flows.get(name);
  if (flow === undefined) throw new InvalidFlowUse(name, "no such flow");

  const params = flowParams(flow, typeof use === "string" ? {} : (use.with ?? {}));
  const filled = flow.steps.map((flowStep) => fillParams(flowStep, params, flow.name) as Step);
  const expanded = expandSteps(filled, flows, flowPath);
  const identity = step.as;
  if (identity === undefined) return expanded;
  return expanded.map((flowStep) => (namesIdentity(flowStep) ? flowStep : { ...flowStep, as: identity }));
}

function namesIdentity(step: Step): boolean {
  const payload = step[stepKind(step)];
  return step.as !== undefined || (typeof payload === "object" && payload !== null && Object.hasOwn(payload, "as"));
}

function flowParams(flow: FlowSpec, given: Readonly<Record<string, string | number | boolean>>): ReadonlyMap<string, string> {
  const missing = flow.params.filter((param) => !Object.hasOwn(given, param));
  if (missing.length > 0) throw new InvalidFlowUse(flow.name, `missing parameter ${missing.join(", ")}`);
  const undeclared = Object.keys(given).filter((key) => !flow.params.includes(key));
  if (undeclared.length > 0) throw new InvalidFlowUse(flow.name, `undeclared parameter ${undeclared.join(", ")}`);
  return new Map(Object.entries(given).map(([key, value]) => [key, String(value)]));
}

function fillParams(value: unknown, params: ReadonlyMap<string, string>, flow: string): unknown {
  if (typeof value === "string") {
    return value.replace(PARAM_PLACEHOLDER, (match: string, name: string, offset: number) => {
      // `$${` escapes a placeholder; it stays for run-time resolution to unescape
      if (value[offset - 1] === "$") return match;
      const param = params.get(name);
      if (param === undefined) throw new InvalidFlowUse(flow, `\${param.${name}} names an undeclared parameter`);
      return param;
    });
  }
  if (Array.isArray(value)) return value.map((item) => fillParams(item, params, flow));
  if (typeof value === "object" && value !== null) {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, fillParams(item, params, flow)]));
  }
  return value;
}
