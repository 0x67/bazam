import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import { basename, isAbsolute, join, relative, resolve } from "node:path";
import { parse } from "yaml";
import { z } from "zod";
import { CredentialCache, Identities, type LoginMode } from "../auth/index.ts";
import { BRAND } from "../brand.ts";
import { bindRoles, roleBindings, type LoadedCase } from "../case/index.ts";
import { oneAtATime, startChallengeService, type ChallengeService, type HumanChannel } from "../challenge/index.ts";
import { guardedHttp, type Capability, type Driver, type DriverSession, type LaunchOptions } from "../driver/index.ts";
import {
  resolvePlaceholders,
  type CaseRunValues,
  type PlaceholderSources,
  type Environment,
  type RunValues,
} from "../env/index.ts";
import type { UnmappedTest } from "../ingest/index.ts";
import type { PluginRegistry } from "../plugin/index.ts";
import {
  declaredSecretNames,
  IdentityFixtures,
  runnerOf,
  type Project,
  type ProjectConfig,
  type RunnerConfig,
} from "../project.ts";
import type { Redactor } from "../redact/index.ts";
import { deriveStatus, EvidenceStore, type CaseOutcome, type CaseResult } from "../result/index.ts";
import { resolveSecret } from "../secrets/index.ts";
import { maskPrompt, RunBrowserLogin } from "./browser-login.ts";
import { CaseEvidence } from "./case-evidence.ts";
import { CaseValues } from "./case-values.ts";
import { CaseRun, placeholderSources, type RunScope } from "./case-run.ts";
import { blockUnreachable, probeEnv, probeHint } from "./env-probes.ts";
import { runExternalSuite, type ExternalSuiteRun } from "./external.ts";
import { finishRun, ProgressFile, progressEntry, RunLog } from "./finish.ts";
import { recordSuite } from "./ingest.ts";
import { IntervalRefresh } from "./interval-refresh.ts";
import { CaseBlocked, isBlocking, messageOf, outcomeOf } from "./outcome.ts";
import {
  caseTarget,
  loginKey,
  loginReason,
  planLogins,
  planRun,
  targetDriver,
  type PlannedCase,
  type PlanInputs,
  type RunPlan,
} from "./plan.ts";
import { runPlanChecks } from "./plan-checks.ts";
import { preflight } from "./preflight.ts";
import { runUnits, type WorkUnit } from "./schedule.ts";

export interface RunOptions {
  project: Project;
  env: Environment;
  cases: readonly LoadedCase[];
  registry: PluginRegistry;
  channel: HumanChannel;
  /** `runs/<run-id>`; its last segment is the run id. */
  runDir: string;
  runValues: RunValues;
  /** The seed `runValues` was made with, recorded in every result so the run can be replayed. */
  seed: number;
  redactor: Redactor;
  signal: AbortSignal;
  /** The targets the run is limited to; a case runs on the first of its own targets listed here. */
  targets?: readonly string[];
  /** How many cases run at once; 1 by default, which runs them one after another in plan order. */
  workers?: number;
  /** The identity each role plays in this run, by role; a role left out plays its default. */
  roles?: Readonly<Record<string, string>>;
}

const LOCAL_FIXTURES_FILE = "fixtures/identities.local.yaml";
// a login trace from preflight lands here; a case id never has this shape
const PREFLIGHT_DIR = "preflight";
// as long as a person has to answer a challenge prompt
const CONFIRM_PROMPT_TIMEOUT_MS = 5 * 60_000;

/** The plan runCases follows, with the targets probed and the cached credentials read. Runs no step and logs in nowhere. */
export async function planCases(options: RunOptions): Promise<RunPlan> {
  return (await Run.open(options)).plan();
}

/**
 * Plans, gets every credential up front in preflight, then runs up to `workers` cases or suites at once, never two
 * that share an identity. Each case gets its own driver session, except that the cases of one runner target run
 * together as one external suite. Writes each case's evidence, status.json after each case, suite and prompt, and
 * finally summary.json, summary.md and post-plan.json in plan order. Throws when the run cannot start, as when the
 * first driver session cannot launch.
 */
export async function runCases(options: RunOptions): Promise<CaseResult[]> {
  const run = await Run.open(options);
  const plan = await run.plan();
  const loginsBlocked = await run.start(plan);
  // started outside every unit's log context, so its lines go to the run log
  await run.startService(plan);
  try {
    const results = await run.runPlan(plan, loginsBlocked);
    await run.finish(results);
    return results;
  } finally {
    await run.closeService();
  }
}

class Run {
  readonly #options: RunOptions;
  readonly #runId: string;
  readonly #fixtures: IdentityFixtures | undefined;
  // the identity each role plays; a case sees only identity names, but a placeholder that resolves later may name a role
  readonly #roles: ReadonlyMap<string, string>;
  readonly #log: RunLog;
  readonly #progress: ProgressFile;
  readonly #logins: RunBrowserLogin;
  readonly #scope: RunScope;
  readonly #probes = new Map<string, Promise<ReadonlySet<Capability>>>();
  // aborted when a work unit throws, as when a driver session fails to launch before any case has started,
  // so the cases still running end blocked "run cancelled"
  readonly #stop = new AbortController();
  #caseStarted = false;
  // the case whose steps run in this async context, for notes the shared HTTP client makes
  readonly #runningCase = new AsyncLocalStorage<CaseEvidence>();
  // the case that runs for each identity it holds, which interval refresh loads credentials into
  readonly #running = new Map<string, { run: CaseRun; evidence: CaseEvidence }>();
  #service: ChallengeService | undefined;
  // by the plan position of each external suite unit, so the summary lists them in plan order
  readonly #unmapped = new Map<number, UnmappedTest[]>();
  // the mtime of each result file, by absolute path, when a suite of this run read it
  readonly #readResults = new Map<string, number>();

  static async open(options: RunOptions): Promise<Run> {
    const { project } = options;
    const bindings = roleBindings(project.config.roles, options.roles ?? {});
    const flows = new Map(
      [...project.flows].map(([name, flow]) => [name, { ...flow, steps: bindRoles(flow.steps, bindings) }]),
    );
    const bound: RunOptions = {
      ...options,
      project: { ...project, flows },
      cases: options.cases.map((loaded) => ({ ...loaded, spec: bindRoles(loaded.spec, bindings) })),
    };
    return new Run(bound, await readLocalFixtures(project.root), bindings);
  }

  private constructor(
    options: RunOptions,
    fixtures: IdentityFixtures | undefined,
    bindings: ReadonlyMap<string, string>,
  ) {
    const { project, env, registry, redactor, runDir } = options;
    const signal = AbortSignal.any([options.signal, this.#stop.signal]);
    this.#options = options;
    this.#runId = basename(runDir);
    this.#fixtures = fixtures;
    this.#roles = bindings;
    this.#log = new RunLog(redactor);
    this.#progress = new ProgressFile(runDir, this.#runId);
    const stateDir = join(project.root, BRAND.stateDir);
    const providers = registry.secretProviders(project.config.secrets.providers);
    // counts a prompt as pending only once it is shown
    const channel = oneAtATime(trackPrompts(options.channel, this.#progress));
    const scope: Omit<RunScope, "identities" | "credentials" | "http"> = {
      runId: this.#runId,
      project,
      env,
      registry,
      redactor,
      signal,
      channel,
      stateDir,
      secret: (key) => resolveSecret(key, providers, redactor),
      identityField: (identity, field) => this.#identityField(identity, field),
      log: this.#log.line,
    };
    // logins and identity settings belong to no case
    const loginSources = placeholderSources(scope, options.runValues.forCase(""));
    const resolve = <T>(value: T): Promise<T> => resolvePlaceholders(value, loginSources);
    this.#logins = new RunBrowserLogin({
      runId: this.#runId,
      flows: project.flows,
      resolve,
      channel,
      redactor,
      signal,
    });
    const identities = new Identities({
      env,
      configs: project.config.identities,
      fixtures: fixtures ?? {},
      registry,
      cache: new CredentialCache(join(stateDir, "credentials")),
      lockDir: join(stateDir, "locks"),
      resolve,
      redactor,
      log: this.#log.line,
      projectRoot: project.root,
      channel,
      browser: this.#logins,
      now: () => new Date(),
    });
    const credentials = blockingCredentials(identities, this.#runningCase, (identity, surface) =>
      this.#running.get(identity)?.run.reloadCredential(identity, surface),
    );
    this.#scope = {
      ...scope,
      identities,
      credentials,
      http: guardedHttp({ env, redactor, log: this.#log.line, identities: credentials }),
    };
  }

  async plan(): Promise<RunPlan> {
    const { project, env, cases, registry, targets } = this.#options;
    const capabilities = new Map<string, ReadonlySet<Capability>>();
    for (const { spec } of cases) {
      const target = caseTarget(spec, targets);
      // planLogins and planRun throw for a target that config lacks only when a case would run on it; a runner has no driver to probe
      if (target === undefined || project.config.targets[target] === undefined) continue;
      if (runnerOf(project.config, target) !== undefined) continue;
      capabilities.set(target, await this.#probe(target));
    }
    const inputs: Omit<PlanInputs, "credentials"> = {
      project,
      env,
      cases,
      capabilities,
      registry,
      blockedIdentities: this.#fixtureProblems(),
      roles: Object.fromEntries(this.#roles),
    };
    if (targets !== undefined) inputs.targets = targets;
    const credentials = new Map<string, LoginMode>();
    for (const login of planLogins(inputs)) {
      credentials.set(loginKey(login), await this.#scope.identities.credentialState(login.identity, login.surface));
    }
    return planRun({ ...inputs, credentials });
  }

  /**
   * Writes the first status.json, asks for each runner that needs a yes in a production env, and runs preflight.
   * Blocks the cases of a runner the person did not confirm; returns the reasons of the logins that failed.
   */
  async start(plan: RunPlan): Promise<ReadonlyMap<string, string>> {
    await this.#progress.update((progress) => {
      progress.total = plan.cases.length;
    });
    // before anything asks or logs in, and with no identities, so a probe never carries a credential
    const { env, redactor, cases, project } = this.#options;
    const http = guardedHttp({ env, redactor, log: this.#log.line });
    blockUnreachable(plan, cases, project, env, await probeEnv(env, http, this.#scope.signal));
    for (const { runner, command } of plan.confirmations) await this.#confirm(plan, runner, command);
    const withLogins = plan.cases.filter((planned) => planned.blocked === undefined && planned.logins.length > 0);
    const blocked = withLogins.length === 0 ? new Map<string, string>() : await this.#logIn(plan, withLogins);
    // plan checks belong to no case, so run and case placeholders have no value
    const checkSources: PlaceholderSources = {
      ...placeholderSources(this.#scope, this.#options.runValues.forCase("")),
      run: () => undefined,
      case: () => undefined,
    };
    await runPlanChecks(this.#options.registry.planChecks(), {
      plan,
      cases,
      loginsBlocked: blocked,
      env,
      http: this.#scope.http,
      secret: (key) => this.#scope.secret(key),
      resolve: (value) => resolvePlaceholders(value, checkSources),
      redactor,
      log: this.#log.line,
    });
    await this.#log.flush(join(this.#options.runDir, "run.log"));
    return blocked;
  }

  /** Runs preflight for the cases' logins in a browser session of its own; returns the reasons of the logins that failed. */
  async #logIn(plan: RunPlan, withLogins: readonly PlannedCase[]): Promise<ReadonlyMap<string, string>> {
    // logins run in a session of their own, launched once and only when a login needs a browser
    const target = await this.#loginTarget(withLogins);
    const launch: { session?: Promise<DriverSession> } = {};
    if (target !== undefined) {
      const { driver, options } = this.#target(target);
      this.#logins.use(() => (launch.session ??= driver.launch(options)));
    }
    const { blocked } = await preflight(plan, this.#scope.identities);
    this.#logins.use(undefined);
    const session = await launch.session?.catch((error: unknown) => {
      throw new Error(`could not launch target ${target} for the logins: ${messageOf(error)}`, { cause: error });
    });
    if (session !== undefined) {
      const evidence = new EvidenceStore(this.#options.runDir, PREFLIGHT_DIR, this.#options.redactor);
      await this.#close(session, { status: blocked.size === 0 ? "pass" : "blocked", evidence });
    }
    return blocked;
  }

  /**
   * When some external suite will run: registers the inherited values of the declared secrets with the redactor,
   * so the runner's output masks them, and starts the run's challenge service.
   */
  async startService(plan: RunPlan): Promise<void> {
    if (!plan.cases.some((planned) => planned.runner !== undefined && planned.blocked === undefined)) return;
    const { project, env, registry, redactor } = this.#options;
    for (const name of declaredSecretNames(project.config)) {
      const value = process.env[name];
      if (value !== undefined && value !== "") redactor.register(value);
    }
    this.#service = await startChallengeService({
      env,
      registry,
      channel: this.#scope.channel,
      http: guardedHttp({ env, redactor, log: this.#log.line }),
      stateDir: this.#scope.stateDir,
      secrets: (key) => this.#scope.secret(key),
      redactor,
      runId: this.#runId,
      log: this.#log.line,
    });
  }

  /** Stops the challenge service, if it started, and writes what the run log still holds. */
  async closeService(): Promise<void> {
    await this.#service?.close();
    await this.#log.flush(join(this.#options.runDir, "run.log"));
  }

  /** Runs the cases up to `workers` at once, never two that share an identity; returns the results in plan order. */
  async runPlan(plan: RunPlan, loginsBlocked: ReadonlyMap<string, string>): Promise<CaseResult[]> {
    const { refresh, counted } = this.#intervalRefresh(plan, loginsBlocked);
    const runUnit = async ({ positions }: WorkUnit): Promise<CaseResult[]> => {
      const position = positions[0]!;
      const planned = plan.cases[position]!;
      try {
        if (planned.runner !== undefined && planned.blocked === undefined) return await this.#runSuite(plan, positions);
        // every other case is a unit of its own
        const loaded = this.#loaded(plan, position);
        return [await this.#log.apart(() => this.runCase(loaded, planned, loginsBlocked))];
      } catch (error) {
        this.#stop.abort();
        throw error;
      } finally {
        const keys = counted.get(planned.caseId);
        if (keys !== undefined) refresh.caseEnded(keys);
      }
    };
    const { config, root } = this.#options.project;
    const units = workUnits(plan, config, root);
    refresh.start();
    try {
      return await runUnits(units, this.#options.workers ?? 1, runUnit, this.#stop.signal);
    } finally {
      await refresh.stop();
    }
  }

  /**
   * Counts, for each credential that sets refreshEveryMs, the cases that use it and will run; `counted` holds the
   * loginKey of each credential a case uses, by case id.
   */
  #intervalRefresh(
    plan: RunPlan,
    loginsBlocked: ReadonlyMap<string, string>,
  ): { refresh: IntervalRefresh; counted: Map<string, string[]> } {
    const { identities } = this.#scope;
    const entries = new Map<string, { identity: string; surface: string; everyMs: number; cases: number }>();
    const counted = new Map<string, string[]>();
    for (const planned of plan.cases) {
      if (planned.blocked !== undefined || planned.runner !== undefined) continue;
      if (loginReason(planned, loginsBlocked) !== undefined) continue;
      const owners = new Map<string, { identity: string; surface: string; everyMs: number }>();
      for (const { identity, surface } of planned.logins) {
        const interval = identities.refreshInterval(identity, surface);
        if (interval !== undefined)
          owners.set(loginKey({ identity, surface: interval.surface }), { identity, ...interval });
      }
      if (owners.size === 0) continue;
      counted.set(planned.caseId, [...owners.keys()]);
      for (const [key, owner] of owners) {
        const entry = entries.get(key) ?? { ...owner, cases: 0 };
        entry.cases += 1;
        entries.set(key, entry);
      }
    }
    const refresh = new IntervalRefresh(
      {
        identities,
        refreshed: ({ identity, surface }) => this.#running.get(identity)?.run.reloadCredential(identity, surface),
        failed: ({ identity }, note) => this.#running.get(identity)?.evidence.note(note),
        log: this.#log.line,
      },
      [...entries.values()],
    );
    return { refresh, counted };
  }

  async runCase(
    loaded: LoadedCase,
    planned: PlannedCase,
    loginsBlocked: ReadonlyMap<string, string>,
  ): Promise<CaseResult> {
    const { spec } = loaded;
    const { runDir, redactor, env, seed } = this.#options;
    const startedAt = new Date();
    const evidence = new CaseEvidence(runDir, spec.id, redactor);
    const runValues = this.#options.runValues.forCase(spec.id);
    const values = new CaseValues(spec.id, spec.title);
    const outcome = await this.#caseOutcome(loaded, planned, { evidence, runValues, values, loginsBlocked });
    const result = await evidence.finish(
      outcome,
      {
        runId: this.#runId,
        title: spec.title,
        stage: spec.stage,
        env: env.name,
        target: planned.target,
        links: spec.links,
        identities: planned.identities,
        seed,
        values: runValues.recorded(),
        caseValues: values.saved(),
        startedAt,
      },
      new Date(),
    );
    await this.#log.flush(join(runDir, spec.id, "case.log"));
    await this.#progress.update((progress) => {
      progress.results.push(progressEntry(result));
    });
    return result;
  }

  async finish(results: readonly CaseResult[]): Promise<void> {
    const { runDir, project, registry, env, cases, redactor } = this.#options;
    const unmapped = [...this.#unmapped].sort(([a], [b]) => a - b).flatMap(([, tests]) => tests);
    await finishRun(runDir, results, unmapped, {
      runId: this.#runId,
      project,
      env,
      cases,
      registry,
      redactor,
      stateDir: this.#scope.stateDir,
      progress: this.#progress,
      log: this.#log,
    });
  }

  /** Asks the person whether the runner may run in this production env; a no, or no answer in time, blocks its cases. */
  async #confirm(plan: RunPlan, runner: string, command: string): Promise<void> {
    const { env, redactor } = this.#options;
    const prompt = maskPrompt(
      {
        // no answer file written before the prompt can hold this id, and --seed cannot make it known; seven hex
        // digits stay under the redactor's rule for runs of eight digits, which would hide the id from prompt_list
        id: `preflight-${runner}-confirm-${randomUUID().slice(0, 7)}`,
        runId: this.#runId,
        caseId: "",
        ask: "verdict",
        title: `Run runner ${runner} against production env ${env.name}?`,
        steps: [
          `It runs \`${command}\`, its whole suite`,
          `${BRAND.name} cannot hold it to the host allowlist or the production write guard`,
        ],
        expected: "Answer y to run it, n to skip it",
        timeoutMs: CONFIRM_PROMPT_TIMEOUT_MS,
      },
      redactor,
    );
    const answer = await this.#scope.channel.ask(prompt, this.#scope.signal);
    if (answer.kind === "verdict" && answer.verdict === "pass") return;
    const note = answer.kind === "verdict" && answer.note !== "" ? `: ${answer.note}` : "";
    for (const planned of plan.cases) {
      if (planned.confirm === runner && planned.blocked === undefined)
        planned.blocked = `production run of runner ${runner} was not confirmed${note}`;
    }
  }

  /** Runs the selected cases of one runner target as one suite and records them from its result files. */
  async #runSuite(plan: RunPlan, positions: readonly number[]): Promise<CaseResult[]> {
    const { project, runDir, redactor, env, seed } = this.#options;
    const { signal } = this.#scope;
    const { target } = plan.cases[positions[0]!]!;
    // the plan sets runner only on a case whose target names one
    const { name, runner, env: targetEnv } = runnerOf(project.config, target)!;
    const cases = positions.map((position) => this.#loaded(plan, position).spec);
    const cwd = resolve(project.root, runner.cwd);
    const startedAt = new Date();
    let failure = signal.aborted ? "run cancelled" : undefined;
    let suiteEnv: Record<string, string> = {};
    try {
      if (failure === undefined) suiteEnv = await this.#resolveSuiteEnv({ ...runner.env, ...targetEnv });
    } catch (error) {
      failure = messageOf(error);
    }
    let run: ExternalSuiteRun | undefined;
    if (failure === undefined) {
      if (this.#service === undefined) throw new Error("the challenge service did not start before the suite");
      run = await runExternalSuite(
        { target, runnerName: name, runner, env: suiteEnv, caseIds: cases.map((spec) => spec.id) },
        {
          root: project.root,
          runDir,
          runId: this.#runId,
          envName: env.name,
          service: this.#service,
          redactor,
          signal,
          now: () => new Date(),
          withheldVars: Object.values(project.config.trackers).flatMap((tracker) => Object.values(tracker.secrets)),
          log: this.#log.line,
        },
      );
      // a later launch failure then blocks only its own case
      if (run.exit.spawnError === undefined) this.#caseStarted = true;
      run.files = await this.#unreadResults(target, cwd, run.files);
      failure = suiteFailure(name, runner, run, signal.aborted);
    }
    const { results, unmapped } = await recordSuite({
      project,
      registry: this.#options.registry,
      redactor,
      log: this.#log.line,
      target,
      runDir,
      runId: this.#runId,
      envName: env.name,
      seed,
      cases,
      files: (run?.files ?? []).map((path) => ({
        path,
        read: () => readFile(join(cwd, path), "utf8"),
      })),
      ...(failure === undefined ? {} : { failure }),
      ...(run === undefined ? {} : { spawnedAt: run.spawnedAt }),
      challenges: this.#service?.answered() ?? new Map(),
      startedAt,
    });
    this.#unmapped.set(positions[0]!, unmapped);
    await this.#progress.update((progress) => {
      progress.results.push(...results.map(progressEntry));
    });
    await this.#log.flush(join(runDir, "run.log"));
    return results;
  }

  /**
   * Leaves out the files an earlier suite of this run read and that have not changed since, so a suite that
   * writes nothing cannot take another target's results. Notes the mtime of each file it keeps.
   */
  async #unreadResults(target: string, cwd: string, files: readonly string[]): Promise<string[]> {
    const unread: string[] = [];
    for (const file of files) {
      const path = join(cwd, file);
      const mtimeMs = (await stat(path).catch(() => undefined))?.mtimeMs;
      if (mtimeMs !== undefined && this.#readResults.get(path) === mtimeMs) {
        this.#log.line(
          `[${target}] skipped ${file}: another target of this run already read it, and it has not changed since`,
        );
        continue;
      }
      if (mtimeMs !== undefined) this.#readResults.set(path, mtimeMs);
      unread.push(file);
    }
    return unread;
  }

  /** Resolves `env`, `secret` and `run` placeholders; a suite belongs to no case and acts as no identity. */
  #resolveSuiteEnv(env: Record<string, string>): Promise<Record<string, string>> {
    const sources = placeholderSources(this.#scope, this.#options.runValues.forCase(""));
    return resolvePlaceholders(env, { ...sources, identity: () => undefined });
  }

  #loaded(plan: RunPlan, position: number): LoadedCase {
    const loaded = this.#options.cases[position];
    if (loaded === undefined)
      throw new Error(`the plan lists case ${plan.cases[position]?.caseId}, which the run was not given`);
    return loaded;
  }

  async #caseOutcome(
    loaded: LoadedCase,
    planned: PlannedCase,
    parts: {
      evidence: CaseEvidence;
      runValues: CaseRunValues;
      values: CaseValues;
      loginsBlocked: ReadonlyMap<string, string>;
    },
  ): Promise<CaseOutcome> {
    const { signal } = this.#scope;
    const reason = signal.aborted ? "run cancelled" : (planned.blocked ?? loginReason(planned, parts.loginsBlocked));
    if (reason !== undefined) return { kind: "blocked", reason };
    const { driver, options } = this.#target(planned.target);
    let session: DriverSession;
    try {
      session = await driver.launch(options);
    } catch (error) {
      const message = `could not launch target ${planned.target}: ${messageOf(error)}`;
      if (!this.#caseStarted) throw new Error(message, { cause: error });
      return { kind: "blocked", reason: message };
    }
    this.#caseStarted = true;
    let outcome: CaseOutcome = { kind: "completed" };
    try {
      await this.#logins.within(
        async () => session,
        () =>
          this.#runningCase.run(parts.evidence, async () => {
            const run = new CaseRun(this.#scope, {
              spec: loaded.spec,
              driver,
              session,
              evidence: parts.evidence,
              runValues: parts.runValues,
              values: parts.values,
            });
            const held = caseLocks(planned);
            for (const identity of held) this.#running.set(identity, { run, evidence: parts.evidence });
            try {
              await run.run();
            } finally {
              for (const identity of held) this.#running.delete(identity);
            }
          }),
      );
    } catch (error) {
      outcome = outcomeOf(error, signal.aborted);
      const hint = probeHint(this.#options.env, error);
      if (outcome.kind === "blocked" && hint !== undefined && !signal.aborted)
        outcome = { ...outcome, reason: `${outcome.reason}; ${hint}` };
      if (outcome.kind === "errored" && outcome.source === "harness") this.#log.line(stackOf(error));
    }
    // the session needs the status first, so a case that did not pass keeps its trace
    const failure = await this.#close(session, {
      status: deriveStatus(parts.evidence.checks, outcome),
      evidence: parts.evidence,
    });
    if (failure === undefined) return outcome;
    // a driver may report on close what its guard refused that no step threw, such as a navigation to another host
    // from a plugin step's page; the refusal outranks the error it caused, as it does for a web step
    const causedByRefusal =
      outcome.kind === "completed" || (outcome.kind === "errored" && outcome.source === "product");
    if (isBlocking(failure) && causedByRefusal) return { kind: "blocked", reason: failure.message };
    if (outcome.kind !== "completed") return outcome;
    return { kind: "errored", source: "harness", message: "closing the driver session failed; case.log has the error" };
  }

  /** Returns what closing threw, if anything; the error also goes to the log. */
  async #close(session: DriverSession, ending: Parameters<DriverSession["close"]>[0]): Promise<unknown> {
    try {
      await session.close(ending);
      return undefined;
    } catch (error) {
      this.#log.line(`closing the driver session failed: ${stackOf(error)}`);
      return error ?? new Error("closing the driver session failed");
    }
  }

  /** Probes each target once per run. */
  #probe(target: string): Promise<ReadonlySet<Capability>> {
    let probed = this.#probes.get(target);
    if (probed === undefined) {
      const { driver, options } = this.#target(target);
      probed = driver.probe(options);
      this.#probes.set(target, probed);
    }
    return probed;
  }

  /** The target of the first of `cases` whose driver offers browser.login, where browser logins can run. */
  async #loginTarget(cases: readonly PlannedCase[]): Promise<string | undefined> {
    for (const { target } of cases) if ((await this.#probe(target)).has("browser.login")) return target;
    return undefined;
  }

  #target(target: string): { driver: Driver; options: LaunchOptions } {
    const { project, registry, env, runDir, redactor } = this.#options;
    const { driver, settings } = targetDriver(project, registry, target);
    return { driver, options: { env, target, settings, runDir, redactor } };
  }

  #identityField(identity: string, field: string): string | undefined {
    const fixture = this.#options.project.config.identities[this.#roles.get(identity) ?? identity]?.fixture;
    return fixture === undefined ? undefined : this.#fixtures?.[fixture]?.[field];
  }

  /** Identities whose fixture the local fixtures file lacks, with the reason. */
  #fixtureProblems(): Map<string, string> {
    const problems = new Map<string, string>();
    for (const [identity, { fixture }] of Object.entries(this.#options.project.config.identities)) {
      if (fixture === undefined) continue;
      if (this.#fixtures === undefined)
        problems.set(identity, `identity ${identity} needs fixture ${fixture}, but ${LOCAL_FIXTURES_FILE} is missing`);
      else if (!Object.hasOwn(this.#fixtures, fixture)) {
        problems.set(
          identity,
          `identity ${identity} needs fixture ${fixture}, which ${LOCAL_FIXTURES_FILE} does not have`,
        );
      }
    }
    for (const [role, { identities }] of Object.entries(this.#options.project.config.roles)) {
      if (this.#roles.has(role)) continue;
      problems.set(
        role,
        `role ${role} plays no identity in this run; pass --as ${role}=<identity>, one of ${identities.join(", ")}`,
      );
    }
    return problems;
  }
}

/**
 * One unit per case, except that the cases of one runner target that are not blocked share one, placed where the
 * first of them sits in the plan.
 */
function workUnits(plan: RunPlan, config: ProjectConfig, root: string): WorkUnit[] {
  const units: WorkUnit[] = [];
  const suites = new Map<string, number[]>();
  plan.cases.forEach((planned, position) => {
    if (planned.runner === undefined || planned.blocked !== undefined) {
      units.push({ positions: [position], locks: caseLocks(planned) });
      return;
    }
    const positions = suites.get(planned.target);
    if (positions !== undefined) {
      positions.push(position);
      return;
    }
    const suite = [position];
    suites.set(planned.target, suite);
    units.push({ positions: suite, locks: suiteLocks(config, root, planned.runner) });
  });
  return units;
}

/**
 * The identities the runner lists, or every identity when it lists none, and the runner itself, since its targets
 * share one results folder. Adds `results:<a>+<b>` for each other runner whose result glob can reach the same
 * files, so one suite never reads what the other is still writing; a lock per pair keeps two runners that each
 * overlap only a third free to run together.
 */
function suiteLocks(config: ProjectConfig, root: string, runner: string): string[] {
  const own = config.runners[runner];
  const identities = own?.identities ?? Object.keys(config.identities);
  const locks = [...identities, `runner:${runner}`];
  if (own === undefined) return locks;
  const ownRoot = resultsRoot(root, own);
  for (const [other, otherRunner] of Object.entries(config.runners)) {
    if (other === runner || !overlaps(ownRoot, resultsRoot(root, otherRunner))) continue;
    locks.push(`results:${[runner, other].sort().join("+")}`);
  }
  return locks;
}

// a glob character in a segment ends the part of the pattern that names a fixed folder
const GLOB_SEGMENT = /[*?[\]{}()!]/;

/** The fixed folder, or file, that every match of the runner's result glob lies in; its cwd when no part is fixed. */
function resultsRoot(root: string, runner: RunnerConfig): string {
  const segments = runner.results.split("/");
  const end = segments.findIndex((segment) => GLOB_SEGMENT.test(segment));
  return resolve(root, runner.cwd, ...(end === -1 ? segments : segments.slice(0, end)));
}

/** Whether two paths are the same or one lies inside the other. */
function overlaps(a: string, b: string): boolean {
  const inside = (from: string, to: string): boolean => {
    const path = relative(from, to);
    return path === "" || (!path.startsWith("..") && !isAbsolute(path));
  };
  return inside(a, b) || inside(b, a);
}

/** Why the suite gave no results to read, or ended early; undefined when its files decide. */
function suiteFailure(
  name: string,
  runner: RunnerConfig,
  run: ExternalSuiteRun,
  cancelled: boolean,
): string | undefined {
  const { exit } = run;
  if (cancelled) return "run cancelled";
  if (exit.spawnError !== undefined) return `runner ${name} could not start: ${exit.spawnError}`;
  if (exit.timedOut) return `runner ${name} timed out after ${runner.timeoutMinutes} min`;
  if (run.files.length > 0) return undefined;
  const ended = exit.signal === null ? `exited ${exit.code}` : `was stopped by ${exit.signal}`;
  return `runner ${name} ${ended} and wrote no results matching ${runner.results}`;
}

/** The identities a case acts as, which no other case acts as while it runs; a blocked case holds none. */
function caseLocks(planned: PlannedCase): string[] {
  if (planned.blocked !== undefined) return [];
  return [...new Set([...planned.identities, ...planned.logins.map((login) => login.identity)])];
}

/** Identities as the step client and browser contexts use it: a credential that cannot be had blocks the case. */
function blockingCredentials(
  identities: Identities,
  runningCase: AsyncLocalStorage<CaseEvidence>,
  reload: (identity: string, surface: string) => void,
): Pick<Identities, "authorize" | "recoverFromUnauthorized"> {
  const blocked =
    (identity: string, surface: string) =>
    (error: unknown): never => {
      throw isBlocking(error)
        ? error
        : new CaseBlocked(`no ${surface} credential for ${identity}: ${messageOf(error)}`);
    };
  return {
    authorize: (identity, surface, target) =>
      identities.authorize(identity, surface, target).catch(blocked(identity, surface)),
    // the HTTP client is shared by every case, so a new login is noted on the case whose async context sent the request
    recoverFromUnauthorized: async (identity, surface) => {
      // a credential that still passes its probe is not the cause of the 401; a probe that throws counts as failing
      if ((await identities.probe(identity, surface).catch(() => false)) === true) return false;
      return identities
        .recoverOrLogIn(identity, surface)
        .then((recovery) => {
          if (recovery === "none") return false;
          if (recovery === "loggedIn")
            runningCase.getStore()?.note(`logged in again as ${identity} on ${surface} after an HTTP 401`);
          // the case's open browser context holds the old credential until it is loaded
          reload(identity, surface);
          return true;
        })
        .catch(blocked(identity, surface));
    },
  };
}

async function readLocalFixtures(root: string): Promise<IdentityFixtures | undefined> {
  let text: string;
  try {
    text = await readFile(join(root, LOCAL_FIXTURES_FILE), "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
  // a file with only comments parses to null
  const parsed = IdentityFixtures.safeParse(parse(text) ?? {});
  if (!parsed.success)
    throw new Error(`${LOCAL_FIXTURES_FILE} does not match the fixtures schema:\n${z.prettifyError(parsed.error)}`);
  return parsed.data;
}

function stackOf(error: unknown): string {
  return error instanceof Error ? (error.stack ?? error.message) : String(error);
}

/** Counts the prompts waiting for a person in status.json. */
function trackPrompts(channel: HumanChannel, progress: ProgressFile): HumanChannel {
  return {
    async ask(prompt, signal) {
      await progress.update((p) => {
        p.pendingPrompts += 1;
      });
      try {
        return await channel.ask(prompt, signal);
      } finally {
        await progress.update((p) => {
          p.pendingPrompts -= 1;
        });
      }
    },
  };
}
