import type { JsonValue, LoginMode } from "../auth/index.ts";
import { BRAND } from "../brand.ts";
import {
  expandFlows,
  stagePolicy,
  stepKind,
  type CaseSpec,
  type ChallengeStep,
  type FlowSpec,
  type GuidedStep,
  type LoadedCase,
  type Stage,
  type Step,
} from "../case/index.ts";
import { chooseResolver, takesValue, type ChallengeResolver } from "../challenge/index.ts";
import type { Capability, Driver } from "../driver/index.ts";
import { assertProdSafe, findPlaceholders, ProdCaseRefused, type Environment } from "../env/index.ts";
import type { PluginRegistry } from "../plugin/index.ts";
import { externalCaseProblem, runnerOf, type Project, type RunnerConfig } from "../project.ts";

// request steps and api checks send as the identity's api surface (see driver/http.ts::httpSteps)
const API_SURFACE = "api";
const HTTP_KINDS: ReadonlySet<string> = new Set(["request", "api"]);
/** The step of the target's driver that a challenge's value answer is filled with. */
export const FILL_STEP = "fill";
// the runner records a note itself, with no handler
const NOTE_STEP = "note";

export interface PlannedCase {
  caseId: string;
  target: string;
  stage: Stage;
  /** The runner of an external case, whose identities, logins and challenges stay empty in the plan. */
  runner?: string;
  identities: string[];
  /** Empty for a blocked case, which logs in nowhere. */
  logins: { identity: string; surface: string; mode: LoginMode }[];
  /** `step` counts the case's expanded steps and then its checks from 1. */
  challenges: { step: number; kind: string; resolver: string | null }[];
  blocked?: string;
  /** The runner that needs a person's yes before this case runs in a production env. */
  confirm?: string;
}

export interface RunPlan {
  env: string;
  cases: PlannedCase[];
  /** The runners that need a person's yes before they run in a production env, once each, in plan order. */
  confirmations: { runner: string; command: string }[];
  /** Guided steps, challenges a person answers, person logins and confirmations, over the cases that are not blocked. */
  personSteps: number;
}

export interface PlanInputs {
  project: Project;
  env: Environment;
  cases: readonly LoadedCase[];
  /** By target. */
  capabilities: ReadonlyMap<string, ReadonlySet<Capability>>;
  /** By `<identity>/<surface>`, as loginKey writes it. */
  credentials: ReadonlyMap<string, LoginMode>;
  registry: PluginRegistry;
  /** The targets the run is limited to; a case runs on the first of its own targets listed here. */
  targets?: readonly string[];
  /** Identities that cannot act in this run, with the reason, such as a fixture the local fixtures file lacks. */
  blockedIdentities?: ReadonlyMap<string, string>;
}

/** An identity's credential for one surface, the one that holds its settings when another reuses it with `from:`. */
export interface Login {
  identity: string;
  surface: string;
}

export function loginKey(login: Login): string {
  return `${login.identity}/${login.surface}`;
}

/** The case's steps and then its checks, flows expanded, in the order they run; a step's number is its index plus one. */
export function caseSteps(spec: CaseSpec, flows: ReadonlyMap<string, FlowSpec>): Step[] {
  return expandFlows([...spec.steps, ...spec.checks], flows);
}

/** The first of the case's targets, or the first that `selected` lists. */
export function caseTarget(spec: CaseSpec, selected: readonly string[] | undefined): string | undefined {
  return selected === undefined ? spec.targets[0] : spec.targets.find((target) => selected.includes(target));
}

/** The driver `targets.<target>.driver` names, and the rest of that entry as its settings. */
export function targetDriver(
  project: Pick<Project, "config">,
  registry: PluginRegistry,
  target: string,
): { driver: Driver; settings: Record<string, JsonValue> } {
  const entry = project.config.targets[target];
  if (entry === undefined) throw new Error(`target ${target} is not defined under targets in ${BRAND.configFile}`);
  if (!("driver" in entry)) throw new Error(`target ${target} names runner ${entry.runner}, not a driver`);
  const { driver, ...settings } = entry;
  return { driver: registry.driver(driver), settings };
}

/** Lists what each case needs and why it would be blocked, without running anything. */
export function planRun(inputs: PlanInputs): RunPlan {
  const analyses = inputs.cases.map((loaded) => analyseCase(loaded, inputs));
  const cases = analyses.map((analysis) => plannedCase(analysis, inputs.credentials));
  const confirmations = new Map<string, string>();
  for (const { confirm } of cases) {
    const runner = confirm === undefined ? undefined : inputs.project.config.runners[confirm];
    if (confirm !== undefined && runner !== undefined) confirmations.set(confirm, runner.command.join(" "));
  }
  return {
    env: inputs.env.name,
    cases,
    confirmations: [...confirmations].map(([runner, command]) => ({ runner, command })),
    personSteps: personSteps(analyses, cases) + confirmations.size,
  };
}

/** The logins of the cases that are not blocked, once each, whose LoginMode planRun needs in `credentials`. */
export function planLogins(inputs: Omit<PlanInputs, "credentials">): Login[] {
  const logins = new Map<string, Login>();
  for (const analysis of inputs.cases.map((loaded) => analyseCase(loaded, inputs))) {
    if (analysis.reasons.length === 0) for (const [key, login] of analysis.logins) logins.set(key, login);
  }
  return [...logins.values()];
}

interface CaseAnalysis {
  caseId: string;
  target: string;
  stage: Stage;
  runner?: string;
  confirm?: string;
  identities: Set<string>;
  logins: Map<string, Login>;
  challenges: { step: number; kind: string; resolver: ChallengeResolver | undefined }[];
  guidedSteps: number;
  /** Why the case would be blocked, in step order; the first one is reported. */
  reasons: string[];
}

function analyseCase(loaded: LoadedCase, inputs: Omit<PlanInputs, "credentials">): CaseAnalysis {
  const { spec } = loaded;
  const target = caseTarget(spec, inputs.targets);
  const analysis: CaseAnalysis = {
    caseId: spec.id,
    target: target ?? spec.targets[0] ?? "",
    stage: spec.stage,
    identities: new Set(),
    logins: new Map(),
    challenges: [],
    guidedSteps: 0,
    reasons: [],
  };
  const external = target === undefined ? undefined : runnerOf(inputs.project.config, target);
  if (external !== undefined) analysis.runner = external.name;
  const refusal =
    caseRefusal(spec, target, inputs) ??
    externalCaseProblem(inputs.project.config, spec)?.message ??
    (external === undefined ? undefined : runnerRefusal(external.name, external.runner, inputs.project));
  if (refusal !== undefined) {
    analysis.reasons.push(refusal);
    return analysis;
  }
  // an external case runs no step of its own, so it needs no driver, identity or login
  if (external !== undefined) {
    if (inputs.env.production && !external.runner.prodSafe) analysis.confirm = external.name;
    return analysis;
  }
  const planner = new StepPlanner(analysis, inputs);
  const steps = caseSteps(spec, inputs.project.flows);
  steps.forEach((step, index) => planner.visit(step, index + 1, step.as));
  for (const name of placeholderIdentities(steps)) planner.identity(name);
  return analysis;
}

/** Why the case does not run here at all, before any of its steps are looked at. */
function caseRefusal(
  spec: CaseSpec,
  target: string | undefined,
  inputs: Omit<PlanInputs, "credentials">,
): string | undefined {
  if (!stagePolicy(spec.stage).runs) return `stage ${spec.stage} does not run`;
  try {
    assertProdSafe(inputs.env, spec);
  } catch (error) {
    if (error instanceof ProdCaseRefused) return error.message;
    throw error;
  }
  if (target === undefined)
    return `none of the case's targets (${spec.targets.join(", ")}) is selected (${inputs.targets?.join(", ")})`;
  return undefined;
}

/** Why the runner cannot run here: no plugin reads its format, or its mapping file did not load. */
function runnerRefusal(
  name: string,
  runner: RunnerConfig,
  project: Pick<Project, "resultFormats" | "mappings">,
): string | undefined {
  if (!project.resultFormats.has(runner.format))
    return `runner ${name} uses format ${runner.format}, which no plugin registers`;
  if (runner.mapping !== undefined && !project.mappings.has(name))
    return `mapping file ${runner.mapping} of runner ${name} did not load`;
  return undefined;
}

/** Walks a case's steps and notes the identities, logins and challenges they need on the case's target. */
class StepPlanner {
  readonly #analysis: CaseAnalysis;
  readonly #inputs: Omit<PlanInputs, "credentials">;
  readonly #driver: Driver;
  readonly #driverKinds: ReadonlySet<string>;

  constructor(analysis: CaseAnalysis, inputs: Omit<PlanInputs, "credentials">) {
    this.#analysis = analysis;
    this.#inputs = inputs;
    this.#driver = targetDriver(inputs.project, inputs.registry, analysis.target).driver;
    this.#driverKinds = new Set(this.#driver.steps.map((handler) => handler.kind));
  }

  /** `identity` is the step's `as`, or the one it inherits from the challenge or guided step it sits in. */
  visit(step: Step, number: number, identity: string | undefined): void {
    const kind = stepKind(step);
    const payload = step[kind];
    const actsInBrowser = identity !== undefined && this.identity(identity) && this.#driverKinds.has(kind);
    if (kind === "challenge") this.#challenge(payload as ChallengeStep, number, identity);
    else if (kind === "guided") this.#guided(payload as GuidedStep, number, identity);
    else if (HTTP_KINDS.has(kind)) this.#request(payloadIdentity(payload) ?? identity);
    else if (kind !== NOTE_STEP && this.#inputs.registry.stepHandler(kind, this.#driver) === undefined) {
      this.#block(`driver ${this.#driver.name} has no ${kind} step`);
    } else if (actsInBrowser) this.#addLogin(identity, this.#driver.surface);
  }

  #challenge(challenge: ChallengeStep, number: number, identity: string | undefined): void {
    const { registry, env } = this.#inputs;
    const kind = registry.kind(challenge.kind);
    const chain = registry.resolverChain(env, challenge.kind);
    const capabilities = this.#inputs.capabilities.get(this.#analysis.target) ?? new Set<Capability>();
    const resolver = chooseResolver(chain, capabilities);
    this.#analysis.challenges.push({ step: number, kind: challenge.kind, resolver });
    if (identity === undefined) this.#block("challenge step names no identity");
    else this.#addLogin(identity, this.#driver.surface);
    if (resolver === undefined)
      this.#block(noResolverReason(challenge.kind, chain, capabilities, env, this.#analysis.target));
    if (takesValue(kind) && challenge.fill === undefined) {
      this.#block(`challenge step ${number} (${challenge.kind}) names no fill field for its code`);
    }
    if (takesValue(kind) && !this.#driverKinds.has(FILL_STEP)) {
      this.#block(`driver ${this.#driver.name} has no ${FILL_STEP} step for the code of challenge step ${number}`);
    }
    const { trigger } = challenge;
    if (trigger !== undefined) this.visit(trigger, number, trigger.as ?? identity);
  }

  #guided(guided: GuidedStep, number: number, identity: string | undefined): void {
    this.#analysis.guidedSteps += 1;
    const { observe } = guided;
    if (observe !== undefined) this.visit(observe, number, observe.as ?? identity);
  }

  /** A request or api check sends with the actor's api credential, so the actor needs one. */
  #request(actor: string | undefined): void {
    if (actor === undefined || !this.identity(actor)) return;
    if (!this.#addLogin(actor, API_SURFACE)) this.#block(`identity ${actor} has no auth for surface ${API_SURFACE}`);
  }

  /** Notes the identity and returns whether it can act: config defines it and nothing blocks it. */
  identity(name: string): boolean {
    this.#analysis.identities.add(name);
    const undefinedInConfig = this.#inputs.project.config.identities[name] === undefined;
    const problem =
      this.#inputs.blockedIdentities?.get(name) ??
      (undefinedInConfig ? `identity ${name} is not defined under identities in ${BRAND.configFile}` : undefined);
    if (problem === undefined) return true;
    this.#block(problem);
    return false;
  }

  /**
   * Notes the login and returns false when the identity has no auth for the surface. On the driver's surface
   * that is no problem: the identity acts in a fresh browser context.
   */
  #addLogin(identity: string, surface: string): boolean {
    const auth = this.#inputs.project.config.identities[identity]?.auth[surface];
    if (auth === undefined) return false;
    const login = { identity, surface: "from" in auth ? auth.from : surface };
    this.#analysis.logins.set(loginKey(login), login);
    return true;
  }

  #block(reason: string): void {
    if (!this.#analysis.reasons.includes(reason)) this.#analysis.reasons.push(reason);
  }
}

/** The identities `${identity.<name>.<field>}` placeholders name, in order. */
function placeholderIdentities(steps: readonly Step[]): string[] {
  const names = findPlaceholders(steps).flatMap(
    (placeholder) => /^\$\{identity\.([^.}]+)\./.exec(placeholder)?.slice(1, 2) ?? [],
  );
  return [...new Set(names)];
}

function payloadIdentity(payload: unknown): string | undefined {
  if (typeof payload !== "object" || payload === null || !("as" in payload)) return undefined;
  return typeof payload.as === "string" ? payload.as : undefined;
}

function noResolverReason(
  kind: string,
  chain: readonly ChallengeResolver[],
  capabilities: ReadonlySet<Capability>,
  env: Environment,
  target: string,
): string {
  if (chain.length === 0) return `env ${env.name} has no resolver chain for challenge ${kind}`;
  const missing = chain.map(
    (resolver) => `${resolver.name} needs ${resolver.requires.filter((c) => !capabilities.has(c)).join(", ")}`,
  );
  return `no resolver for challenge ${kind} can run on target ${target}: ${missing.join("; ")}`;
}

function plannedCase(analysis: CaseAnalysis, credentials: ReadonlyMap<string, LoginMode>): PlannedCase {
  const blocked = analysis.reasons[0];
  const planned: PlannedCase = {
    caseId: analysis.caseId,
    target: analysis.target,
    stage: analysis.stage,
    ...(analysis.runner === undefined ? {} : { runner: analysis.runner }),
    identities: [...analysis.identities],
    logins:
      blocked === undefined
        ? [...analysis.logins.values()].map((login) => ({ ...login, mode: loginMode(credentials, login) }))
        : [],
    challenges: analysis.challenges.map(({ step, kind, resolver }) => ({
      step,
      kind,
      resolver: resolver?.name ?? null,
    })),
  };
  if (blocked !== undefined) planned.blocked = blocked;
  else if (analysis.confirm !== undefined) planned.confirm = analysis.confirm;
  return planned;
}

function loginMode(credentials: ReadonlyMap<string, LoginMode>, login: Login): LoginMode {
  const mode = credentials.get(loginKey(login));
  if (mode === undefined)
    throw new Error(`no login mode for ${loginKey(login)}; planLogins lists the logins to look up`);
  return mode;
}

function personSteps(analyses: readonly CaseAnalysis[], cases: readonly PlannedCase[]): number {
  const personLogins = new Set<string>();
  let steps = 0;
  analyses.forEach((analysis, index) => {
    const planned = cases[index];
    if (planned === undefined || planned.blocked !== undefined) return;
    steps +=
      analysis.guidedSteps + analysis.challenges.filter((challenge) => challenge.resolver?.automated === false).length;
    for (const login of planned.logins) if (login.mode === "person") personLogins.add(loginKey(login));
  });
  return steps + personLogins.size;
}
