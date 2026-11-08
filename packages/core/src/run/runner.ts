import { AsyncLocalStorage } from "node:async_hooks";
import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { parse } from "yaml";
import { z } from "zod";
import { CredentialCache, Identities, type LoginMode } from "../auth/index.ts";
import { BRAND } from "../brand.ts";
import type { LoadedCase } from "../case/index.ts";
import { oneAtATime, type HumanChannel } from "../challenge/index.ts";
import { guardedHttp, type Capability, type Driver, type DriverSession, type LaunchOptions } from "../driver/index.ts";
import { resolvePlaceholders, type CaseRunValues, type Environment, type RunValues } from "../env/index.ts";
import type { PluginRegistry } from "../plugin/index.ts";
import { IdentityFixtures, type Project } from "../project.ts";
import type { Redactor } from "../redact/index.ts";
import { buildPostPlans, loadReceipts, PeopleRegistry } from "../report/index.ts";
import {
  deriveStatus,
  EvidenceStore,
  writeRunStatus,
  writeRunSummary,
  type CaseOutcome,
  type CaseResult,
  type RunProgress,
} from "../result/index.ts";
import { resolveSecret } from "../secrets/index.ts";
import { RunBrowserLogin } from "./browser-login.ts";
import { CaseEvidence } from "./case-evidence.ts";
import { CaseRun, placeholderSources, type RunScope } from "./case-run.ts";
import { CaseBlocked, isBlocking, messageOf, outcomeOf } from "./outcome.ts";
import {
  caseTarget,
  loginKey,
  planLogins,
  planRun,
  targetDriver,
  type PlannedCase,
  type PlanInputs,
  type RunPlan,
} from "./plan.ts";
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
}

const LOCAL_FIXTURES_FILE = "fixtures/identities.local.yaml";
// a login trace from preflight lands here; a case id never has this shape
const PREFLIGHT_DIR = "preflight";

/** The plan runCases follows, with the targets probed and the cached credentials read. Runs no step and logs in nowhere. */
export async function planCases(options: RunOptions): Promise<RunPlan> {
  return (await Run.open(options)).plan();
}

/**
 * Plans, gets every credential up front in preflight, then runs each case in its own driver session, up to
 * `workers` at once and never two that share an identity. Writes each case's evidence, status.json after each
 * case and prompt, and finally summary.json, summary.md and post-plan.json in plan order. Throws when the run
 * cannot start, as when the first driver session cannot launch.
 */
export async function runCases(options: RunOptions): Promise<CaseResult[]> {
  const run = await Run.open(options);
  const plan = await run.plan();
  const loginsBlocked = await run.start(plan);
  const results = await run.runPlan(plan, loginsBlocked);
  await run.finish(results);
  return results;
}

class Run {
  readonly #options: RunOptions;
  readonly #runId: string;
  readonly #fixtures: IdentityFixtures | undefined;
  readonly #log: RunLog;
  readonly #progress: ProgressFile;
  readonly #logins: RunBrowserLogin;
  readonly #scope: RunScope;
  readonly #probes = new Map<string, Promise<ReadonlySet<Capability>>>();
  // aborted when a case throws, so the cases still running end blocked "run cancelled"
  readonly #stop = new AbortController();
  #caseStarted = false;

  static async open(options: RunOptions): Promise<Run> {
    return new Run(options, await readLocalFixtures(options.project.root));
  }

  private constructor(options: RunOptions, fixtures: IdentityFixtures | undefined) {
    const { project, env, registry, redactor, runDir } = options;
    const signal = AbortSignal.any([options.signal, this.#stop.signal]);
    this.#options = options;
    this.#runId = basename(runDir);
    this.#fixtures = fixtures;
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
    const credentials = blockingCredentials(identities);
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
      // planRun names a target that config lacks, for the cases that would run on it
      if (target === undefined || project.config.targets[target] === undefined) continue;
      capabilities.set(target, await this.#probe(target));
    }
    const inputs: Omit<PlanInputs, "credentials"> = {
      project,
      env,
      cases,
      capabilities,
      registry,
      blockedIdentities: this.#fixtureProblems(),
    };
    if (targets !== undefined) inputs.targets = targets;
    const credentials = new Map<string, LoginMode>();
    for (const login of planLogins(inputs)) {
      credentials.set(loginKey(login), await this.#scope.identities.credentialState(login.identity, login.surface));
    }
    return planRun({ ...inputs, credentials });
  }

  /** Writes the first status.json and runs preflight; returns the reasons of the logins that failed. */
  async start(plan: RunPlan): Promise<ReadonlyMap<string, string>> {
    await this.#progress.update((progress) => {
      progress.total = plan.cases.length;
    });
    const withLogins = plan.cases.filter((planned) => planned.blocked === undefined && planned.logins.length > 0);
    if (withLogins.length === 0) return new Map();
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
    await this.#log.flush(join(this.#options.runDir, "run.log"));
    return blocked;
  }

  /** Runs the cases up to `workers` at once, never two that share an identity; returns the results in plan order. */
  runPlan(plan: RunPlan, loginsBlocked: ReadonlyMap<string, string>): Promise<CaseResult[]> {
    const units = plan.cases.map((planned, position) => ({ positions: [position], locks: caseLocks(planned) }));
    const runUnit = async ({ positions }: WorkUnit): Promise<CaseResult[]> => {
      // each case is a unit of its own
      const position = positions[0]!;
      const planned = plan.cases[position]!;
      const loaded = this.#options.cases[position];
      try {
        if (loaded === undefined) throw new Error(`the plan lists case ${planned.caseId}, which the run was not given`);
        return [await this.#log.apart(() => this.runCase(loaded, planned, loginsBlocked))];
      } catch (error) {
        this.#stop.abort();
        throw error;
      }
    };
    return runUnits(units, this.#options.workers ?? 1, runUnit, this.#stop.signal);
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
    const outcome = await this.#caseOutcome(loaded, planned, { evidence, runValues, loginsBlocked });
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
        startedAt,
      },
      new Date(),
    );
    await this.#log.flush(join(runDir, spec.id, "case.log"));
    await this.#progress.update((progress) => {
      progress.results.push({
        caseId: result.caseId,
        status: result.status,
        ...(result.reason === undefined ? {} : { reason: result.reason }),
      });
    });
    return result;
  }

  async finish(results: readonly CaseResult[]): Promise<void> {
    const { runDir, project, registry, env, cases, redactor } = this.#options;
    await writeRunSummary(runDir, results);
    const postPlan = buildPostPlans({
      runId: this.#runId,
      env: env.name,
      results,
      specs: new Map(cases.map(({ spec }) => [spec.id, spec])),
      people: await PeopleRegistry.load(project.root),
      receipts: await loadReceipts(this.#scope.stateDir),
      trackers: (name) => registry.tracker(name),
      transitions: project.config.trackers,
      now: new Date(),
    });
    // only the comments go through the redactor again: its digit rule would break account ids and receipt URLs
    const masked = {
      ...postPlan,
      items: postPlan.items.map((item) => ({ ...item, comment: redactor.value(item.comment) })),
    };
    await writeFile(join(runDir, "post-plan.json"), `${JSON.stringify(masked, null, 2)}\n`);
    await this.#progress.update((progress) => {
      progress.state = "finished";
    });
    await this.#log.flush(join(runDir, "run.log"));
  }

  async #caseOutcome(
    loaded: LoadedCase,
    planned: PlannedCase,
    parts: { evidence: CaseEvidence; runValues: CaseRunValues; loginsBlocked: ReadonlyMap<string, string> },
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
          new CaseRun(this.#scope, {
            spec: loaded.spec,
            driver,
            session,
            evidence: parts.evidence,
            runValues: parts.runValues,
          }).run(),
      );
    } catch (error) {
      outcome = outcomeOf(error, signal.aborted);
      if (outcome.kind === "errored" && outcome.source === "harness") this.#log.line(stackOf(error));
    }
    // the session needs the status first, so a case that did not pass keeps its trace
    const failure = await this.#close(session, {
      status: deriveStatus(parts.evidence.checks, outcome),
      evidence: parts.evidence,
    });
    if (failure === undefined || outcome.kind !== "completed") return outcome;
    // a driver may report on close what its guard refused after the last step, such as a navigation to another host
    if (isBlocking(failure)) return { kind: "blocked", reason: failure.message };
    return { kind: "errored", source: "harness", message: "closing the driver session failed" };
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
    const fixture = this.#options.project.config.identities[identity]?.fixture;
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
    return problems;
  }
}

/** The identities a case acts as, which no other case acts as while it runs; a blocked case holds none. */
function caseLocks(planned: PlannedCase): string[] {
  if (planned.blocked !== undefined) return [];
  return [...new Set([...planned.identities, ...planned.logins.map((login) => login.identity)])];
}

function loginReason(planned: PlannedCase, loginsBlocked: ReadonlyMap<string, string>): string | undefined {
  return planned.logins.map((login) => loginsBlocked.get(loginKey(login))).find((reason) => reason !== undefined);
}

/** Identities as the step client and browser contexts use it: a credential that cannot be had blocks the case. */
function blockingCredentials(identities: Identities): Pick<Identities, "authorize" | "recoverFromUnauthorized"> {
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
    recoverFromUnauthorized: (identity, surface) =>
      identities.recoverFromUnauthorized(identity, surface).catch(blocked(identity, surface)),
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

/**
 * Collects log lines and appends them, masked, to the run log or a case log. A line goes to the buffer of the
 * `apart` call whose async context logs it, else to the run's.
 */
class RunLog {
  readonly #redactor: Redactor;
  readonly #runLines: string[] = [];
  readonly #caseLines = new AsyncLocalStorage<string[]>();

  constructor(redactor: Redactor) {
    this.#redactor = redactor;
  }

  readonly line = (text: string): void => {
    this.#lines().push(text);
  };

  /** Runs `fn` with a buffer of its own, which `flush` inside it writes. */
  apart<T>(fn: () => Promise<T>): Promise<T> {
    return this.#caseLines.run([], fn);
  }

  /** Writes the current buffer. Masks at write time, so a secret registered after its line was logged is masked too. */
  async flush(file: string): Promise<void> {
    const lines = this.#lines().splice(0);
    if (lines.length === 0) return;
    const text = this.#redactor.text(`${lines.join("\n")}\n`);
    await mkdir(dirname(file), { recursive: true });
    await appendFile(file, text);
  }

  #lines(): string[] {
    return this.#caseLines.getStore() ?? this.#runLines;
  }
}

/** The run's progress and its status.json, rewritten after each change. */
class ProgressFile {
  readonly #runDir: string;
  readonly #progress: RunProgress;
  #writing: Promise<void> = Promise.resolve();

  constructor(runDir: string, runId: string) {
    this.#runDir = runDir;
    this.#progress = { runId, state: "running", total: 0, pendingPrompts: 0, results: [] };
  }

  /** Writes one at a time, since a prompt can end while the runner writes after a case. */
  update(change: (progress: RunProgress) => void): Promise<void> {
    change(this.#progress);
    const snapshot = structuredClone(this.#progress);
    const write = this.#writing.then(() => writeRunStatus(this.#runDir, snapshot));
    // the caller of a failed write gets its error; the next write still goes ahead
    this.#writing = write.catch(() => undefined);
    return write;
  }
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
