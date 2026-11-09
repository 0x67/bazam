import { AsyncLocalStorage } from "node:async_hooks";
import type { BrowserSession, Identities } from "../auth/index.ts";
import { stepKind, type CaseSpec, type ChallengeStep, type GuidedStep, type Step } from "../case/index.ts";
import {
  checkGuidedOutcome,
  resolveChallenge,
  type ChallengeRequest,
  type GuidedObservation,
  type HumanChannel,
  type PersonPrompt,
  type ResolverContext,
} from "../challenge/index.ts";
import type { Driver, DriverSession, StepContext } from "../driver/index.ts";
import type { GuardedHttp } from "../driver/http.ts";
import {
  escapePlaceholders,
  resolvePlaceholders,
  type CaseRunValues,
  type Environment,
  type PlaceholderSources,
} from "../env/index.ts";
import type { PluginRegistry } from "../plugin/index.ts";
import { PluginCallFailed } from "../plugin/process.ts";
import type { Project } from "../project.ts";
import type { Redactor } from "../redact/index.ts";
import { maskPrompt } from "./browser-login.ts";
import type { CaseEvidence } from "./case-evidence.ts";
import { CaseBlocked, isBlocking, messageOf, StepFailed } from "./outcome.ts";
import { caseSteps, FILL_STEP } from "./plan.ts";

const CHALLENGE_PROMPT_TIMEOUT_MS = 5 * 60_000;
const GUIDED_PROMPT_TIMEOUT_MS = 15 * 60_000;

/** What every case of a run shares. */
export interface RunScope {
  runId: string;
  project: Project;
  env: Environment;
  registry: PluginRegistry;
  redactor: Redactor;
  signal: AbortSignal;
  identities: Identities;
  /** Identities for the runner's own authorize calls, where a credential that cannot be had blocks the case. */
  credentials: Pick<Identities, "authorize">;
  http: GuardedHttp;
  channel: HumanChannel;
  /** `<root>/<stateDir>` */
  stateDir: string;
  secret(key: string): Promise<string>;
  /** The identity's field from the local fixtures file. */
  identityField(identity: string, field: string): string | undefined;
  /** Adds a line to the log of the case that runs. */
  log(line: string): void;
}

/** Placeholder sources for one case, or for logins, which belong to no case and see no `${case.X}`. */
export function placeholderSources(
  scope: Pick<RunScope, "env" | "secret" | "identityField">,
  runValues: CaseRunValues,
  caseValues?: ReadonlyMap<string, string>,
): PlaceholderSources {
  return {
    env: (key) => scope.env.vars[key],
    secret: (key) => scope.secret(key),
    identity: (name, field) => scope.identityField(name, field),
    run: (expression) => runValues.value(expression),
    case: (key) => caseValues?.get(key),
    locale: scope.env.locale,
  };
}

export interface CaseParts {
  spec: CaseSpec;
  driver: Driver;
  session: DriverSession;
  evidence: CaseEvidence;
  runValues: CaseRunValues;
}

/** Runs one case's steps and checks in its driver session. */
export class CaseRun {
  readonly #scope: RunScope;
  readonly #parts: CaseParts;
  readonly #values: Map<string, string>;
  readonly #sources: PlaceholderSources;
  /** Identities whose browser context is open and authorized. */
  readonly #browsers = new Set<string>();
  /** Calls that remove the 401 listener from each browser context this case authorized. */
  readonly #stops: (() => void)[] = [];
  // the probe or recovery a 401 started; a 401 that arrives meanwhile adds nothing
  #recovery: Promise<void> | undefined;
  #recovered = false;
  #notedLater = false;

  constructor(scope: RunScope, parts: CaseParts) {
    this.#scope = scope;
    this.#parts = parts;
    this.#values = new Map([
      ["id", parts.spec.id],
      ["title", parts.spec.title],
    ]);
    this.#sources = placeholderSources(scope, parts.runValues, this.#values);
  }

  /** Runs the steps and then the checks in order; the first one that throws ends the case. */
  async run(): Promise<void> {
    const steps = caseSteps(this.#parts.spec, this.#scope.project.flows);
    try {
      for (const [index, step] of steps.entries()) await this.#step(step, index + 1, step.as);
    } finally {
      for (const stop of this.#stops) stop();
      // the session closes after this returns, so never under a refresh
      await this.#recovery;
    }
  }

  /** `identity` is the step's `as`, or the one it inherits from the challenge or guided step it sits in. */
  async #step(step: Step, number: number, identity: string | undefined): Promise<void> {
    // no step acts while a refresh replaces the credential under the page
    await this.#recovery;
    this.#scope.signal.throwIfAborted();
    const kind = stepKind(step);
    const payload = step[kind];
    if (kind === "note") return this.#parts.evidence.note(await this.#resolve(payload as string));
    if (kind === "challenge") return this.#challenge(payload as ChallengeStep, number, identity);
    if (kind === "guided") return this.#guided(payload as GuidedStep, number, identity);
    const { driver } = this.#parts;
    const handler = this.#scope.registry.stepHandler(kind, driver);
    // the plan blocks a case with a step its target's driver lacks
    if (handler === undefined) throw new Error(`driver ${driver.name} has no ${kind} step`);
    if (identity !== undefined && driver.steps.includes(handler)) await this.#openBrowser(identity);
    try {
      await handler.run(payload, this.#context(identity));
    } catch (error) {
      // a process plugin that exits, stalls or breaks the protocol is the harness's fault, never the product's
      throw isBlocking(error) || error instanceof PluginCallFailed ? error : new StepFailed(number, kind, error);
    }
  }

  async #challenge(challenge: ChallengeStep, number: number, identity: string | undefined): Promise<void> {
    if (identity === undefined) throw new CaseBlocked("challenge step names no identity");
    const { registry, env, redactor } = this.#scope;
    await this.#openBrowser(identity);
    const request: ChallengeRequest = {
      kind: challenge.kind,
      caseId: this.#parts.spec.id,
      identity,
      step: number,
      params: await this.#resolve(challenge.params ?? {}),
    };
    const { trigger } = challenge;
    const runTrigger = async (): Promise<void> => {
      if (trigger !== undefined) await this.#step(trigger, number, trigger.as ?? identity);
    };
    const kind = registry.kind(challenge.kind);
    const { answer, resolver } = await resolveChallenge(
      request,
      kind,
      registry.resolverChain(env, challenge.kind),
      this.#resolverContext(),
      runTrigger,
    );
    this.#parts.evidence.challenge(number, challenge.kind, resolver);
    if (answer.kind !== "value") return;
    redactor.register(answer.value);
    // the plan blocks a value challenge without a fill field
    if (challenge.fill === undefined) throw new Error(`challenge step ${number} has no fill field`);
    // the fill handler resolves its payload, and an answer is text to type, never a placeholder
    await this.#step(
      { [FILL_STEP]: { field: challenge.fill, value: escapePlaceholders(answer.value) } },
      number,
      identity,
    );
  }

  async #guided(guided: GuidedStep, number: number, identity: string | undefined): Promise<void> {
    const text = await this.#resolve({ title: guided.title, steps: guided.steps, expected: guided.expected });
    const prompt: PersonPrompt = {
      id: `${this.#parts.spec.id}-${number}-guided`,
      runId: this.#scope.runId,
      caseId: this.#parts.spec.id,
      ask: "verdict",
      title: text.title,
      steps: text.steps,
      timeoutMs: GUIDED_PROMPT_TIMEOUT_MS,
    };
    if (text.expected !== undefined) prompt.expected = text.expected;
    const screenshot = this.#parts.evidence.latestScreenshot;
    if (screenshot !== undefined) prompt.screenshot = screenshot;
    const answer = await this.#scope.channel.ask(maskPrompt(prompt, this.#scope.redactor), this.#scope.signal);
    const { observe } = guided;
    // a blocked verdict blocks the case, so nothing is observed
    const observes = answer.kind === "verdict" && answer.verdict !== "blocked" && observe !== undefined;
    const observation = observes ? await this.#observe(observe, number, observe.as ?? identity) : undefined;
    // the name keeps the placeholders as written, so it never holds a resolved secret
    this.#parts.evidence.record(
      checkGuidedOutcome(guided.title, text.expected ?? "the person confirms the steps", answer, observation),
    );
  }

  /** What the observe step found, taken from the checks it recorded; a product error is a failed observation. */
  async #observe(step: Step, number: number, identity: string | undefined): Promise<GuidedObservation> {
    try {
      const checks = await this.#parts.evidence.capture(() => this.#step(step, number, identity));
      const observed = checks.map((check) => `${check.name}: ${JSON.stringify(check.observed)}`).join("; ");
      return { ok: checks.every((check) => check.ok), observed: observed === "" ? "the observe step ran" : observed };
    } catch (error) {
      if (error instanceof StepFailed) return { ok: false, observed: error.message };
      throw error;
    }
  }

  /** Opens the identity's browser context once per case and applies its credential for the driver's surface, if it has one. */
  async #openBrowser(identity: string): Promise<void> {
    const { session, driver } = this.#parts;
    if (this.#browsers.has(identity) || session.browserFor === undefined) return;
    const browser = await session.browserFor(identity);
    if (this.#scope.project.config.identities[identity]?.auth[driver.surface] !== undefined) {
      await this.#scope.credentials.authorize(identity, driver.surface, { kind: "browser", session: browser });
      // a pooled browser calls back in the async context of the case that launched it, so bind runs the listener in this case's context
      const listener = AsyncLocalStorage.bind((origin: string) =>
        this.#unauthorized(identity, driver.surface, browser, origin),
      );
      const stop = browser.onUnauthorized?.(listener);
      if (stop !== undefined) this.#stops.push(stop);
    }
    this.#browsers.add(identity);
  }

  /** Probes after a 401 until the case has had its one recovery; after that, one 401 more adds a note. */
  #unauthorized(identity: string, surface: string, browser: BrowserSession, origin: string): void {
    if (this.#recovery !== undefined) return;
    if (this.#recovered) {
      if (!this.#notedLater) this.#parts.evidence.note(`another 401 from ${origin} after the refresh`);
      this.#notedLater = true;
      return;
    }
    this.#recovery = this.#recover(identity, surface, browser, origin).finally(() => {
      this.#recovery = undefined;
    });
  }

  /** Never throws, so the step that saw the 401 keeps its own outcome. */
  async #recover(identity: string, surface: string, browser: BrowserSession, origin: string): Promise<void> {
    const { identities, credentials } = this.#scope;
    const { evidence } = this.#parts;
    // a probe that throws counts as failing, so the refresh runs
    const passes = await identities.probe(identity, surface).catch(() => false);
    if (passes === true) {
      this.#scope.log(`401 from ${origin}; the ${surface} credential of ${identity} still passes its probe`);
      return;
    }
    this.#recovered = true;
    try {
      if (await identities.recoverFromUnauthorized(identity, surface)) {
        await credentials.authorize(identity, surface, { kind: "browser", session: browser });
        evidence.note(`refreshed ${identity}'s ${surface} credential after a 401 from ${origin}`);
      } else {
        evidence.note(`got a 401 from ${origin}; the ${surface} credential of ${identity} cannot be refreshed`);
      }
    } catch (error) {
      evidence.note(
        `refreshing ${identity}'s ${surface} credential after a 401 from ${origin} failed: ${messageOf(error)}`,
      );
    }
  }

  #context(identity: string | undefined): StepContext {
    const { session, evidence } = this.#parts;
    const { env, identities, http, signal } = this.#scope;
    const ctx: StepContext = {
      session,
      env,
      evidence,
      identities,
      values: this.#values,
      http,
      resolve: (value) => this.#resolve(value),
      signal,
    };
    if (identity !== undefined) ctx.identity = identity;
    return ctx;
  }

  #resolverContext(): ResolverContext {
    const { env, http, channel, stateDir, signal, runId } = this.#scope;
    const prompt: ResolverContext["prompt"] = { runId, timeoutMs: CHALLENGE_PROMPT_TIMEOUT_MS };
    const screenshot = this.#parts.evidence.latestScreenshot;
    if (screenshot !== undefined) prompt.screenshot = screenshot;
    return {
      env,
      http,
      session: this.#parts.session,
      channel,
      prompt,
      stateDir,
      secrets: (key) => this.#scope.secret(key),
      now: () => new Date(),
      signal,
    };
  }

  #resolve<T>(value: T): Promise<T> {
    return resolvePlaceholders(value, this.#sources);
  }
}
