import { AsyncLocalStorage } from "node:async_hooks";
import type { BrowserSession, Identities } from "../auth/index.ts";
import {
  stepKind,
  type CaseSpec,
  type ChallengeStep,
  type GuidedStep,
  type Step,
} from "../case/index.ts";
import {
  checkGuidedOutcome,
  resolveChallenge,
  type ChallengeRequest,
  type GuidedObservation,
  type HumanChannel,
  type PersonPrompt,
  type ResolverContext,
} from "../challenge/index.ts";
import type { CaseValues } from "./case-values.ts";
import type { Driver, DriverSession, StepContext } from "../driver/index.ts";
import type { GuardedHttp } from "../driver/http.ts";
import {
  escapePlaceholders,
  findPlaceholders,
  resolvePlaceholders,
  type CaseRunValues,
  type Environment,
  type PlaceholderSources,
  UnresolvedPlaceholder,
} from "../env/index.ts";
import type { PluginRegistry } from "../plugin/index.ts";
import { PluginCallFailed } from "../plugin/process.ts";
import type { Project } from "../project.ts";
import type { Redactor } from "../redact/index.ts";
import type { StepTime } from "../result/index.ts";
import { maskPrompt } from "./browser-login.ts";
import type { CaseEvidence, StepMarks } from "./case-evidence.ts";
import {
  CaseBlocked,
  HarnessError,
  isBlocking,
  messageOf,
  SessionLost,
  StepFailed,
} from "./outcome.ts";
import { caseSteps, FILL_STEP, finallySteps, stepCount } from "./plan.ts";

const CHALLENGE_PROMPT_TIMEOUT_MS = 5 * 60_000;
const GUIDED_PROMPT_TIMEOUT_MS = 15 * 60_000;
const FINALLY_BUDGET_MS = 2 * 60_000;

/** What started a recovery: a 401, a redirect to the login page, or a step that landed on it. */
type RecoveryCause =
  | { kind: "unauthorized"; origin: string }
  | { kind: "redirect"; url: string }
  // the page URL is not known to core, so the cause names the step
  | { kind: "landed"; step: string };

type RecoveryResult = "stillValid" | "refreshed" | "loggedIn" | "cannotRecover" | "failed";

/** The words notes and log lines use for a cause. */
function describeCause(cause: RecoveryCause): { event: string; after: string; another: string } {
  if (cause.kind === "unauthorized") {
    const event = `a 401 from ${cause.origin}`;
    return { event, after: event, another: `another 401 from ${cause.origin}` };
  }
  if (cause.kind === "redirect") {
    const url = new URL(cause.url);
    const to = `${url.origin}${url.pathname}`;
    return {
      event: `a redirect to ${to}`,
      after: `a redirect to ${to}`,
      another: `another redirect to ${to}`,
    };
  }
  const event = `${cause.step} landed on the login page`;
  return { event, after: event, another: event };
}

/** A copy of the step without its level and callout, for a step whose checks are notes. */
function unmarked(step: Step): Step {
  const { level: _level, callout: _callout, ...rest } = step;
  return rest;
}

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

/** Placeholder sources for one case, or for logins and external suites, which belong to no case and see no `${case.X}`. */
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
  values: CaseValues;
}

/** Runs one case's steps and checks in its driver session. */
export class CaseRun {
  readonly #scope: RunScope;
  readonly #parts: CaseParts;
  readonly #values: Map<string, string>;
  readonly #sources: PlaceholderSources;
  /** Identities whose browser context this case has opened, authorized when the identity has auth for the driver's surface. */
  readonly #browsers = new Map<string, BrowserSession>();
  /** Calls that remove the 401 listener from each browser context this case authorized. */
  readonly #stops: (() => void)[] = [];
  // the probe or recovery a 401 started; a 401 that arrives meanwhile adds nothing
  #recovery: Promise<void> | undefined;
  // the recovery that the current top-level step's own events started, so a SessionLost waits only for that one
  #stepRecovery: { identity: string; result: Promise<RecoveryResult> } | undefined;
  #recovered = false;
  #notedLater = false;
  // set when a login after a 401 failed; the main loop throws it before the next step
  #pendingBlock: CaseBlocked | undefined;
  #blockReported = false;
  // set once the case's own work is done, so a refresh that fires later leaves the session alone
  #closing = false;
  // the run's signal until the finally steps start; they get one of their own that a cancel does not abort
  #signal: AbortSignal;

  constructor(scope: RunScope, parts: CaseParts) {
    this.#scope = scope;
    this.#parts = parts;
    this.#signal = scope.signal;
    this.#values = parts.values;
    this.#sources = placeholderSources(scope, parts.runValues, this.#values);
  }

  /** Runs the steps and then the checks in order, the first one that throws ends them, and then the finally steps. */
  async run(): Promise<void> {
    const { flows } = this.#scope.project;
    const steps = caseSteps(this.#parts.spec, flows);
    const before = stepCount(this.#parts.spec, flows);
    try {
      for (const [index, step] of steps.entries()) {
        await this.#recovery;
        this.#throwPendingBlock();
        this.#stepRecovery = undefined;
        await this.#timed(index + 1, stepKind(step), index < before ? "steps" : "checks", () =>
          this.#step(step, index + 1, step.as),
        );
      }
      await this.#recovery;
      this.#throwPendingBlock();
    } finally {
      await this.#recovery;
      this.#noteUnreportedBlock();
      // the 401 listeners stay on, so a finally step that meets an expired session still recovers
      await this.#runFinally(steps.length);
      for (const stop of this.#stops) stop();
      // the session closes after this returns, so never under a refresh
      this.#closing = true;
      while (this.#recovery !== undefined) await this.#recovery;
      this.#noteUnreportedBlock();
    }
  }

  /** Runs `run` and records when it started and how long it took, also when it throws. */
  async #timed(
    number: number,
    kind: string,
    list: StepTime["list"],
    run: () => Promise<void>,
  ): Promise<void> {
    const startedAt = new Date().toISOString();
    const began = performance.now();
    try {
      await run();
    } finally {
      this.#parts.evidence.stepTime({
        number,
        kind,
        list,
        startedAt,
        durationMs: Math.round(performance.now() - began),
      });
    }
  }

  #throwPendingBlock(): void {
    if (this.#pendingBlock === undefined) return;
    this.#blockReported = true;
    throw this.#pendingBlock;
  }

  // a step that failed on its own keeps the case's outcome, but the reason of the failed login stays in the result
  #noteUnreportedBlock(): void {
    if (this.#pendingBlock === undefined || this.#blockReported) return;
    this.#blockReported = true;
    this.#parts.evidence.note(this.#pendingBlock.message);
  }

  /** Runs every finally step under its own signal and turns what goes wrong, and each check, into notes. Never throws. */
  async #runFinally(before: number): Promise<void> {
    const steps = finallySteps(this.#parts.spec, this.#scope.project.flows);
    if (steps.length === 0) return;
    const { evidence } = this.#parts;
    this.#signal = AbortSignal.timeout(FINALLY_BUDGET_MS);
    for (const [index, step] of steps.entries()) {
      const number = before + index + 1;
      const kind = stepKind(step);
      await this.#recovery;
      if (this.#signal.aborted) {
        evidence.note(
          `finally steps ${number} to ${before + steps.length} did not run: the 2 minute budget ran out`,
        );
        return;
      }
      if (kind === "challenge" || kind === "guided") {
        evidence.note(`finally step ${number} (${kind}) skipped: finally steps run unattended`);
        continue;
      }
      this.#stepRecovery = undefined;
      let failure: unknown;
      const checks = await evidence.recordAside(() =>
        this.#timed(number, kind, "finally", async () => {
          try {
            await this.#step(unmarked(step), number, step.as);
          } catch (error) {
            failure = error;
          }
        }),
      );
      if (failure !== undefined) {
        const cause = failure instanceof StepFailed ? failure.cause : failure;
        evidence.note(`finally step ${number} (${kind}) failed: ${messageOf(cause)}`);
      }
      for (const check of checks)
        evidence.note(`finally check ${check.name}: ${check.ok ? "ok" : "not ok"}`);
    }
  }

  /** `identity` is the step's `as`, or the one it inherits from the challenge or guided step it sits in. */
  async #step(step: Step, number: number, identity: string | undefined): Promise<void> {
    const marks: StepMarks = {};
    if (step.level !== undefined) marks.level = step.level;
    if (step.callout !== undefined) marks.callout = step.callout;
    if (Object.keys(marks).length === 0) return this.#runStep(step, number, identity);
    return this.#parts.evidence.marked(marks, () => this.#runStep(step, number, identity));
  }

  async #runStep(step: Step, number: number, identity: string | undefined): Promise<void> {
    // no step acts while a refresh replaces the credential under the page
    await this.#recovery;
    this.#signal.throwIfAborted();
    const kind = stepKind(step);
    const payload = step[kind];
    if (kind === "note") {
      const text = await this.#resolve(payload as string);
      if (step.callout === true) this.#parts.evidence.callout(text);
      else this.#parts.evidence.note(text);
      return;
    }
    if (kind === "followup") {
      const { name, hint } = payload as { name: string; hint: string };
      return this.#parts.evidence.followup(name, await this.#resolve(hint));
    }
    if (kind === "challenge") return this.#challenge(payload as ChallengeStep, number, identity);
    if (kind === "guided") return this.#guided(payload as GuidedStep, number, identity);
    const { driver } = this.#parts;
    const handler = this.#scope.registry.stepHandler(kind, driver);
    // the plan blocks a case with a step its target's driver lacks
    if (handler === undefined) throw new Error(`driver ${driver.name} has no ${kind} step`);
    if (identity !== undefined && (driver.steps.includes(handler) || handler.opensBrowser === true))
      await this.#openBrowser(identity);
    if (kind === FILL_STEP) await this.#maskFilled(payload);
    const attempt = async (): Promise<void> => {
      try {
        await handler.run(payload, this.#context(identity));
      } catch (error) {
        if (error instanceof SessionLost) throw error;
        // a process plugin that exits, stalls or breaks the protocol is the harness's fault, never the product's
        throw isBlocking(error) ||
          error instanceof PluginCallFailed ||
          error instanceof HarnessError
          ? error
          : new StepFailed(number, kind, error);
      }
    };
    try {
      await attempt();
    } catch (error) {
      if (!(error instanceof SessionLost)) throw error;
      const label = `step ${number} (${kind})`;
      await this.#afterSessionLost(label, identity);
      try {
        await attempt();
      } catch (again) {
        if (again instanceof SessionLost)
          throw new CaseBlocked(
            `${label} landed on the login page again after the session was recovered`,
          );
        throw again;
      }
    }
  }

  /** Recovers the session a step lost and notes that the step runs again; throws a block when it cannot run again. */
  async #afterSessionLost(label: string, identity: string | undefined): Promise<void> {
    const { driver } = this.#parts;
    const surface = driver.surface;
    const browser = identity === undefined ? undefined : this.#browsers.get(identity);
    if (
      identity === undefined ||
      browser === undefined ||
      this.#scope.project.config.identities[identity]?.auth[surface] === undefined
    )
      throw new CaseBlocked(
        `${label} landed on the login page, but it acts as no identity with ${surface} auth`,
      );
    if (this.#stepRecovery?.identity !== identity) {
      while (this.#recovery !== undefined) await this.#recovery;
      if (!this.#recovered)
        this.#unauthorized(identity, surface, browser, { kind: "landed", step: label });
    }
    const started = this.#stepRecovery;
    if (started?.identity !== identity)
      throw new CaseBlocked(
        `${label} lost the ${surface} session of ${identity} again after this case's one recovery`,
      );
    const result = await started.result;
    const credential = `the ${surface} credential of ${identity}`;
    if (result === "failed") {
      // a failed recovery always sets the block
      this.#throwPendingBlock();
    } else if (result === "stillValid") {
      throw new CaseBlocked(
        `${label} landed on the login page, but ${credential} still passes its probe`,
      );
    } else if (result === "cannotRecover") {
      throw new CaseBlocked(
        `${label} landed on the login page, and ${credential} cannot be refreshed or logged in again`,
      );
    } else {
      this.#parts.evidence.note(
        `${label} ran again after ${result === "refreshed" ? `refreshing ${identity}'s ${surface} credential` : `logging in again as ${identity} on ${surface}`}`,
      );
    }
  }

  async #challenge(
    challenge: ChallengeStep,
    number: number,
    identity: string | undefined,
  ): Promise<void> {
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
    const text = await this.#resolve({
      title: guided.title,
      steps: guided.steps,
      expected: guided.expected,
    });
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
    const answer = await this.#scope.channel.ask(
      maskPrompt(prompt, this.#scope.redactor),
      this.#scope.signal,
    );
    const { observe } = guided;
    // a blocked verdict blocks the case, so nothing is observed
    const observes =
      answer.kind === "verdict" && answer.verdict !== "blocked" && observe !== undefined;
    const observation = observes
      ? await this.#observe(observe, number, observe.as ?? identity)
      : undefined;
    // the name keeps the placeholders as written, so it never holds a resolved secret
    this.#parts.evidence.record(
      checkGuidedOutcome(
        guided.title,
        text.expected ?? "the person confirms the steps",
        answer,
        observation,
      ),
    );
  }

  /** What the observe step found, taken from the checks it recorded; a product error is a failed observation. */
  async #observe(
    step: Step,
    number: number,
    identity: string | undefined,
  ): Promise<GuidedObservation> {
    try {
      const checks = await this.#parts.evidence.capture(() => this.#step(step, number, identity));
      const observed = checks
        .map((check) => `${check.name}: ${JSON.stringify(check.observed)}`)
        .join("; ");
      return {
        ok: checks.every((check) => check.ok),
        observed: observed === "" ? "the observe step ran" : observed,
      };
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
      await this.#scope.credentials.authorize(identity, driver.surface, {
        kind: "browser",
        session: browser,
      });
      // a pooled browser calls back in the async context of the case that launched it, so bind runs the listener in this case's context
      const listener = AsyncLocalStorage.bind((origin: string) =>
        this.#unauthorized(identity, driver.surface, browser, { kind: "unauthorized", origin }),
      );
      const stop = browser.onUnauthorized?.(listener);
      if (stop !== undefined) this.#stops.push(stop);
      const pattern = await this.#scope.identities.lostOn(identity, driver.surface);
      if (pattern !== undefined) {
        const lost = AsyncLocalStorage.bind((url: string) =>
          this.#unauthorized(identity, driver.surface, browser, { kind: "redirect", url }),
        );
        const stopLost = browser.onSessionLost?.(pattern, lost);
        if (stopLost !== undefined) this.#stops.push(stopLost);
      }
    }
    this.#browsers.set(identity, browser);
  }

  /** Probes after a 401 or a redirect to the login page until the case has had its one recovery; after that, one more adds a note. */
  #unauthorized(
    identity: string,
    surface: string,
    browser: BrowserSession,
    cause: RecoveryCause,
  ): void {
    if (this.#recovery !== undefined) return;
    if (this.#recovered) {
      if (!this.#notedLater)
        this.#parts.evidence.note(`${describeCause(cause).another} after this case's one recovery`);
      this.#notedLater = true;
      return;
    }
    const result = this.#recover(identity, surface, browser, cause);
    const recovery: Promise<void> = result
      .then(() => undefined)
      .finally(() => {
        if (this.#recovery === recovery) this.#recovery = undefined;
      });
    this.#recovery = recovery;
    this.#stepRecovery = { identity, result };
  }

  /**
   * Loads the identity's current credential into its open browser context before the next step starts, when the
   * browser's surface takes its credential from the same surface as `surface`. Never throws; a credential that
   * fails to load becomes a note.
   */
  reloadCredential(identity: string, surface: string): void {
    const browser = this.#browsers.get(identity);
    const { driver, evidence } = this.#parts;
    const { identities } = this.#scope;
    if (
      this.#closing ||
      browser === undefined ||
      this.#scope.project.config.identities[identity]?.auth[driver.surface] === undefined
    )
      return;
    // the browser may use another surface that reuses this one with from:
    if (
      identities.ownerSurface(identity, driver.surface) !==
      identities.ownerSurface(identity, surface)
    )
      return;
    const loading: Promise<void> = Promise.resolve(this.#recovery)
      .then(() =>
        this.#scope.credentials.authorize(identity, driver.surface, {
          kind: "browser",
          session: browser,
        }),
      )
      .catch((error: unknown) => {
        evidence.note(
          `loading ${identity}'s refreshed ${driver.surface} credential failed: ${messageOf(error)}`,
        );
      })
      .finally(() => {
        if (this.#recovery === loading) this.#recovery = undefined;
      });
    this.#recovery = loading;
  }

  /** Never throws, so the step that saw the 401 keeps its own outcome. */
  async #recover(
    identity: string,
    surface: string,
    browser: BrowserSession,
    cause: RecoveryCause,
  ): Promise<RecoveryResult> {
    const { identities, credentials } = this.#scope;
    const { evidence } = this.#parts;
    // a probe that throws counts as failing, so the refresh runs
    const passes = await identities.probe(identity, surface).catch(() => false);
    const { event, after } = describeCause(cause);
    if (passes === true) {
      this.#scope.log(
        `${cause.kind === "unauthorized" ? `401 from ${cause.origin}` : event}; the ${surface} credential of ${identity} still passes its probe`,
      );
      return "stillValid";
    }
    this.#recovered = true;
    try {
      const recovery = await identities.recoverOrLogIn(identity, surface);
      if (recovery === "none") {
        evidence.note(
          `${cause.kind === "landed" ? event : `got ${event}`}; the ${surface} credential of ${identity} cannot be refreshed`,
        );
        return "cannotRecover";
      }
      await credentials.authorize(identity, surface, { kind: "browser", session: browser });
      evidence.note(
        recovery === "refreshed"
          ? `refreshed ${identity}'s ${surface} credential after ${after}`
          : `logged in again as ${identity} on ${surface} after ${after}`,
      );
      return recovery;
    } catch (error) {
      this.#pendingBlock = new CaseBlocked(
        `logging in again as ${identity} on ${surface} after ${after} failed: ${messageOf(error)}`,
      );
      return "failed";
    }
  }

  #context(identity: string | undefined): StepContext {
    const { session, evidence } = this.#parts;
    const { env, identities, http } = this.#scope;
    const ctx: StepContext = {
      session,
      env,
      evidence,
      identities,
      values: this.#values,
      http,
      resolve: (value) => this.#resolve(value),
      mask: (value) => this.#scope.redactor.register(value),
      signal: this.#signal,
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

  /** Registers each identity field value a fill step types, except the fields `redaction.shown` lists. */
  async #maskFilled(payload: unknown): Promise<void> {
    const value = (payload as { value?: unknown } | null)?.value;
    if (typeof value !== "string") return;
    const { shown } = this.#scope.project.config.redaction;
    for (const placeholder of findPlaceholders(value)) {
      const [namespace, , field] = placeholder.slice(2, -1).split(".");
      if (namespace !== "identity" || field === undefined || shown.includes(field)) continue;
      try {
        this.#scope.redactor.register(await this.#resolve(placeholder));
      } catch (error) {
        if (!(error instanceof UnresolvedPlaceholder)) throw error;
      }
    }
  }

  #resolve<T>(value: T): Promise<T> {
    return resolvePlaceholders(value, this.#sources);
  }
}
