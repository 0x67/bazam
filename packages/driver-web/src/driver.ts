import { mkdtemp, readFile, rm } from "node:fs/promises";
import { connect } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import type { BrowserLogin, BrowserLoginRequest, BrowserSession, StorageState } from "@bazam/core/auth";
import { BRAND } from "@bazam/core/brand";
import { Selector, stepKind, type Step } from "@bazam/core/case";
import {
  ConnectionFailed,
  defineDriver,
  type Capability,
  type CaseEnding,
  type DriverSession,
  type LaunchOptions,
  type StepEvidence,
  type StepHandler,
} from "@bazam/core/driver";
import { assertHostAllowed, type Environment } from "@bazam/core/env";
import { CaseBlocked } from "@bazam/core/run";
import type { Redactor } from "@bazam/core/redact";
import type { CheckRecord } from "@bazam/core/result";
import { chromium, firefox, webkit, type Browser, type BrowserContext, type Locator, type Page } from "playwright";
import { z } from "zod";
import { GuardedContext, Refusals } from "./context.ts";
import { PlaywrightLogin, storageStateOf, urlMatches, type LoginTab } from "./login.ts";
import { poll as pollFor } from "./poll.ts";
import { describeSelector, locate } from "./selectors.ts";
import { scrubTrace } from "./trace.ts";

// every Playwright in the peer range has BrowserContext.credentials, a virtual authenticator that works on every engine
const CAPABILITIES: ReadonlySet<Capability> = new Set(["browser.login", "webauthn.virtual"]);
const ENGINES = { chromium, firefox, webkit };
// an unused browser closes after this long so the process can exit; a case or login that starts before then reuses it
const BROWSER_IDLE_MS = 2_000;
// the default of Playwright's own expect
const EXPECT_TIMEOUT_MS = 5_000;
const EXPECT_POLL_MS = 100;
const CONNECT_PROBE_TIMEOUT_MS = 5_000;

const WebSettings = z
  .strictObject({
    browser: z.enum(["chromium", "firefox", "webkit"]).default("chromium"),
    channel: z.enum(["chrome", "msedge"]).optional(),
    headless: z.boolean().default(true),
    // the attribute goes unescaped into a CSS selector, where "." or ":" would break it
    testIdAttribute: z
      .string()
      .regex(/^[A-Za-z_][A-Za-z0-9_-]*$/, {
        error: 'testIdAttribute takes a letter or "_", then letters, digits, "_" or "-", as in "data-testid"',
      })
      .default("data-testid"),
  })
  .refine((settings) => settings.channel === undefined || settings.browser === "chromium", {
    path: ["channel"],
    error: "a channel needs browser: chromium",
  });
type WebSettings = z.infer<typeof WebSettings>;

function parseSettings(options: LaunchOptions): WebSettings {
  const parsed = WebSettings.safeParse(options.settings);
  if (!parsed.success) throw new Error(`target ${options.target}: ${z.prettifyError(parsed.error)}`);
  return parsed.data;
}

type BrowserKind = Pick<WebSettings, "browser" | "channel" | "headless">;

interface PooledBrowser {
  browser: Promise<Browser>;
  users: number;
  idle: NodeJS.Timeout | undefined;
}

interface BrowserLease {
  browser: Promise<Browser>;
  release(): void;
}

// one browser per kind for the whole run, shared by the sessions of its cases
const pool = new Map<string, PooledBrowser>();

function leaseBrowser(kind: BrowserKind): BrowserLease {
  const key = JSON.stringify([kind.browser, kind.channel ?? null, kind.headless]);
  let pooled = pool.get(key);
  if (pooled === undefined) {
    const entry: PooledBrowser = { browser: launchBrowser(kind), users: 0, idle: undefined };
    const forget = (): void => {
      if (pool.get(key) === entry) pool.delete(key);
    };
    // a failed launch or a crashed browser leaves the pool, so the next lease starts a new one
    entry.browser.then((browser) => browser.on("disconnected", forget), forget);
    pool.set(key, entry);
    pooled = entry;
  }
  const entry = pooled;
  clearTimeout(entry.idle);
  entry.users += 1;
  let released = false;
  return {
    browser: entry.browser,
    release() {
      if (released) return;
      released = true;
      entry.users -= 1;
      if (entry.users > 0) return;
      entry.idle = setTimeout(() => {
        if (pool.get(key) === entry) pool.delete(key);
        // the browser is gone either way, so a failed close needs nothing more
        entry.browser.then((browser) => browser.close()).catch(() => {});
      }, BROWSER_IDLE_MS).unref();
    },
  };
}

// the mask selector lists that parsed, so each is checked once per process
const parsedMaskSelectors = new Set<string>();

/**
 * Throws when Playwright cannot parse a selector that screenshots mask, so a typo in the redaction config stops the
 * run at launch instead of failing every screenshot step as if the product had.
 */
async function assertMaskSelectorsParse(browser: Browser, selectors: readonly string[]): Promise<void> {
  const key = JSON.stringify(selectors);
  if (selectors.length === 0 || parsedMaskSelectors.has(key)) return;
  const context = await browser.newContext();
  try {
    // a blank page matches nothing, so counting only parses the selector
    const page = await context.newPage();
    for (const selector of selectors) {
      await page
        .locator(selector)
        .count()
        .catch((error: unknown) => {
          const [reason] = (error instanceof Error ? error.message : String(error)).split("\n");
          throw new Error(`redaction.screenshotSelectors has "${selector}", which Playwright cannot parse: ${reason}`);
        });
    }
  } finally {
    await context.close();
  }
  parsedMaskSelectors.add(key);
}

function launchBrowser(kind: BrowserKind): Promise<Browser> {
  return ENGINES[kind.browser].launch({
    headless: kind.headless,
    // Playwright's own handler would exit 130 on Ctrl-C before the run can record its cases as cancelled
    handleSIGINT: false,
    ...(kind.channel === undefined ? {} : { channel: kind.channel }),
  });
}

/**
 * ConnectionFailed when nothing accepts a connection at the URL's host and port. Each engine, and WebKit on each OS,
 * words a refused connection or an unknown host its own way, so the driver connects from here to tell that apart
 * from a server that answered badly.
 */
async function unreachable(url: URL): Promise<ConnectionFailed | undefined> {
  const port = Number(url.port || (url.protocol === "https:" ? 443 : 80));
  // URL keeps the brackets of an IPv6 host, which connect does not take
  const host = url.hostname.replace(/^\[(.*)\]$/, "$1");
  const failure = await new Promise<Error | undefined>((settle) => {
    const socket = connect({ host, port, timeout: CONNECT_PROBE_TIMEOUT_MS });
    socket.once("connect", () => {
      socket.destroy();
      settle(undefined);
    });
    socket.once("timeout", () => {
      socket.destroy();
      settle(new Error(`connect timed out after ${CONNECT_PROBE_TIMEOUT_MS} ms`));
    });
    socket.once("error", settle);
  });
  return failure === undefined
    ? undefined
    : new ConnectionFailed(`GET ${url.origin}${url.pathname}`, failure.message, { cause: failure, host: url.hostname });
}

type PlaywrightStorageState = Exclude<Parameters<BrowserContext["setStorageState"]>[0], string>;
type Passkeys = Awaited<ReturnType<BrowserContext["credentials"]["get"]>>;

/** setStorageState also removes virtual passkeys and their authenticator, so the passkeys go back in with the state. */
async function loadStorageState(context: BrowserContext, state: StorageState): Promise<void> {
  const credentials = await context.credentials.get();
  // Playwright reads credentials in a storage state, which its type leaves out, and installs the authenticator for them
  const next: PlaywrightStorageState & { credentials?: Passkeys } =
    credentials.length === 0
      ? (state as PlaywrightStorageState)
      : { ...(state as PlaywrightStorageState), credentials };
  await context.setStorageState(next);
}

/** What a web step acts on; a login has a page but no evidence. */
interface StepScope {
  page: Page;
  env: Environment;
  testIdAttribute: string;
  redactor: Redactor;
  evidence: StepEvidence | undefined;
  signal: AbortSignal | undefined;
}

interface WebStep<S> extends StepHandler<S> {
  /** `written` is the payload before placeholders were filled, for names that must not hold a secret. */
  act(payload: S, scope: StepScope, written: S): Promise<void>;
}

function webStep<S>(kind: string, schema: z.ZodType<S>, act: WebStep<S>["act"]): WebStep<S> {
  return {
    kind,
    schema,
    act,
    async run(written, ctx) {
      const session = webSession(ctx.session);
      const guarded = await session.contextFor(ctx.identity);
      const page = await guarded.page();
      const payload = await ctx.resolve(written);
      const scope: StepScope = { ...session.scope(page), evidence: ctx.evidence, signal: ctx.signal };
      await guarded.run(() => act(payload, scope, written));
    },
  };
}

function field(scope: StepScope, selector: Selector): Locator {
  return locate(scope.page, selector, scope.testIdAttribute);
}

function caseEvidence(scope: StepScope, kind: string): StepEvidence {
  if (scope.evidence === undefined) throw new Error(`a ${kind} step runs only inside a case, not in a browser login`);
  return scope.evidence;
}

const Expectation = z.union([
  z.strictObject({ visible: Selector }),
  z.strictObject({
    text: z.union([
      z.strictObject({ field: Selector, equals: z.string() }),
      z.strictObject({ field: Selector, contains: z.string() }),
    ]),
  }),
  z.strictObject({ url: z.string().min(1) }),
]);
type Expectation = z.infer<typeof Expectation>;

const WaitStep = z.union([z.strictObject({ ms: z.number().int().positive() }), z.strictObject({ for: Selector })]);

const steps: readonly WebStep<unknown>[] = [
  webStep("open", z.string().min(1), async (url, { page, env }) => {
    const target = new URL(url);
    assertHostAllowed(env, target);
    await page.goto(target.href).catch(async (error: unknown) => {
      throw (await unreachable(target)) ?? error;
    });
  }),
  webStep("tap", Selector, async (selector, scope) => {
    await field(scope, selector).click();
  }),
  webStep("fill", z.strictObject({ field: Selector, value: z.string() }), async (fill, scope) => {
    await field(scope, fill.field).fill(fill.value);
  }),
  webStep("press", z.strictObject({ key: z.string().min(1), field: Selector.optional() }), async (press, scope) => {
    await (press.field === undefined
      ? scope.page.keyboard.press(press.key)
      : field(scope, press.field).press(press.key));
  }),
  webStep("select", z.strictObject({ field: Selector, option: z.string().min(1) }), async (select, scope) => {
    await field(scope, select.field).selectOption(select.option);
  }),
  webStep("expect", Expectation, async (expectation, scope, written) => {
    const evidence = caseEvidence(scope, "expect");
    evidence.record({ name: expectationName(written), kind: "ui", ...(await observe(expectation, scope)) });
  }),
  webStep("screenshot", z.strictObject({ name: z.string().min(1) }), async ({ name }, scope) => {
    const evidence = caseEvidence(scope, "screenshot");
    const mask = scope.redactor.selectors().map((css) => scope.page.locator(css));
    // masking finds the elements in the page, so a navigation the last step started can interrupt it
    const shot = await poll(
      () => scope.page.screenshot({ mask }),
      () => true,
    );
    await evidence.attach(name, shot.value, "png");
  }),
  webStep("wait", WaitStep, async (wait, scope) => {
    if ("for" in wait) await field(scope, wait.for).waitFor({ state: "visible" });
    else await sleep(wait.ms, undefined, scope.signal === undefined ? {} : { signal: scope.signal });
  }),
];

const stepsByKind: ReadonlyMap<string, WebStep<unknown>> = new Map(steps.map((step) => [step.kind, step]));

/** Runs a step of a login flow, which arrives with its placeholders filled. */
async function runFlowStep(step: Step, scope: StepScope): Promise<void> {
  const kind = stepKind(step);
  const handler = stepsByKind.get(kind);
  if (handler === undefined) throw new Error(`a browser login runs web steps only, and "${kind}" is not one`);
  const payload = handler.schema.parse(step[kind]);
  await handler.act(payload, scope, payload);
}

function expectationName(expectation: Expectation): string {
  if ("visible" in expectation) return `${describeSelector(expectation.visible)} is visible`;
  if ("url" in expectation) return `URL matches ${expectation.url}`;
  const text = expectation.text;
  const target = `text of ${describeSelector(text.field)}`;
  return "equals" in text ? `${target} equals "${text.equals}"` : `${target} contains "${text.contains}"`;
}

/** Waits up to the expect timeout for the page to meet the expectation, and reports what it last saw. */
async function observe(
  expectation: Expectation,
  scope: StepScope,
): Promise<Pick<CheckRecord, "expected" | "observed" | "ok">> {
  if ("visible" in expectation) {
    const locator = field(scope, expectation.visible);
    const seen = await poll(
      () => locator.isVisible(),
      (visible) => visible,
    );
    return { expected: "visible", observed: seen.value ? "visible" : "not visible", ok: seen.ok };
  }
  if ("url" in expectation) {
    const seen = await poll(
      async () => scope.page.url(),
      (url) => urlMatches(expectation.url, url),
    );
    return { expected: expectation.url, observed: seen.value, ok: seen.ok };
  }
  const text = expectation.text;
  const locator = field(scope, text.field);
  const matches = (observed: string): boolean =>
    "equals" in text ? observed === normalizeSpace(text.equals) : observed.includes(normalizeSpace(text.contains));
  const seen = await poll(async () => normalizeSpace((await locator.allTextContents()).join(" ")), matches);
  return {
    expected: "equals" in text ? { equals: text.equals } : { contains: text.contains },
    observed: seen.value,
    ok: seen.ok,
  };
}

function poll<T>(read: () => Promise<T>, ok: (value: T) => boolean): Promise<{ value: T; ok: boolean }> {
  return pollFor(read, ok, EXPECT_TIMEOUT_MS, EXPECT_POLL_MS);
}

function normalizeSpace(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

/** One case on one target: a context per identity, plus an anonymous one for steps that name none. */
export class WebSession implements DriverSession {
  readonly capabilities = CAPABILITIES;
  readonly browserLogin: BrowserLogin;
  /** Virtual passkeys register their private keys here, since traces record them. */
  readonly redactor: Redactor;
  readonly #env: Environment;
  readonly #settings: WebSettings;
  readonly #browser: Browser;
  readonly #lease: BrowserLease;
  readonly #contexts = new Map<string | undefined, Promise<GuardedContext>>();
  // one for all the case's contexts, so a refusal in one is thrown by the next web step in any of them
  readonly #refusals = new Refusals();

  constructor(options: LaunchOptions, settings: WebSettings, browser: Browser, lease: BrowserLease) {
    this.redactor = options.redactor;
    this.#env = options.env;
    this.#settings = settings;
    this.#browser = browser;
    this.#lease = lease;
    this.browserLogin = new PlaywrightLogin((request) => this.#openLoginTab(request));
  }

  async browserFor(identity: string): Promise<BrowserSession> {
    const guarded = await this.contextFor(identity);
    return {
      storageState: () => storageStateOf(guarded.context),
      loadStorageState: (state) => loadStorageState(guarded.context, state),
      setExtraHeaders: (headers) => guarded.setHeaders(headers),
      setHttpCredentials: (credentials) => guarded.setCredentials(credentials),
      onUnauthorized: (listener) => guarded.onUnauthorized(listener),
    };
  }

  /** The identity's context, or the anonymous one; each records a trace from the moment it opens. */
  contextFor(identity: string | undefined): Promise<GuardedContext> {
    let opened = this.#contexts.get(identity);
    if (opened === undefined) {
      opened = this.#openCaseContext();
      this.#contexts.set(identity, opened);
    }
    return opened;
  }

  scope(page: Page): Omit<StepScope, "evidence" | "signal"> {
    return { page, env: this.#env, testIdAttribute: this.#settings.testIdAttribute, redactor: this.redactor };
  }

  /** Throws a navigation refused after the last web step that could have thrown it, once the traces are kept. */
  async close(ending: CaseEnding): Promise<void> {
    const saved: SavedTrace[] = [];
    try {
      const several = this.#contexts.size > 1;
      for (const [identity, opening] of this.#contexts) {
        // a context that failed to open already failed the step that asked for it
        const guarded = await opening.catch(() => undefined);
        if (guarded === undefined) continue;
        const label = several ? `trace-${identity ?? "anonymous"}` : "trace";
        // closing can still refuse a navigation the page started, so the traces are held until every context has closed
        saved.push(await this.#saveTrace(guarded.context, label));
        await guarded.close();
      }
    } finally {
      if (ending.status !== "pass" || this.#refusals.unthrown() !== undefined) {
        for (const trace of saved) await this.#attachTrace(trace, ending.evidence);
      }
      await Promise.all(saved.map((trace) => rm(trace.dir, { recursive: true, force: true })));
      this.#contexts.clear();
      this.#lease.release();
    }
    const late = this.#refusals.unthrown();
    if (late !== undefined) throw late;
  }

  async #openCaseContext(): Promise<GuardedContext> {
    const context = await this.#browser.newContext();
    // screencast frames are images the scrubber cannot read, and sources would copy test files into the zip
    await context.tracing.start({
      // a DOM snapshot would show what screenshots mask; Playwright drops network entries along with it
      snapshots: this.redactor.selectors().length === 0,
      screenshots: false,
      sources: false,
    });
    return GuardedContext.open(context, this.#env, this.#refusals);
  }

  /** Stops the trace into a temporary folder the caller removes; a failure to stop is kept for the note. */
  async #saveTrace(context: BrowserContext, label: string): Promise<SavedTrace> {
    // outside runs/, so the unscrubbed zip never sits beside the evidence
    const dir = await mkdtemp(join(tmpdir(), `${BRAND.name}-trace-`));
    try {
      await context.tracing.stop({ path: join(dir, "trace.zip") });
      return { label, dir, failure: undefined };
    } catch (error) {
      return { label, dir, failure: error instanceof Error ? error.message : String(error) };
    }
  }

  /** Attaches the scrubbed trace; when stopping or scrubbing failed, notes why and attaches nothing. */
  async #attachTrace(trace: SavedTrace, evidence: StepEvidence): Promise<void> {
    let failure = trace.failure;
    if (failure === undefined) {
      try {
        const zip = await readFile(join(trace.dir, "trace.zip"));
        await evidence.attach(trace.label, scrubTrace(zip, this.redactor), "zip");
      } catch (error) {
        failure = error instanceof Error ? error.message : String(error);
      }
    }
    if (failure !== undefined) evidence.note(`${trace.label}.zip was left out: ${failure}`);
  }

  async #openLoginTab(request: BrowserLoginRequest): Promise<LoginTab> {
    // a person cannot act in a browser they cannot see
    const lease = leaseBrowser(request.prompt === undefined ? this.#settings : { ...this.#settings, headless: false });
    try {
      const guarded = await GuardedContext.open(await (await lease.browser).newContext(), this.#env, new Refusals());
      const page = await guarded.page();
      const scope: StepScope = { ...this.scope(page), evidence: undefined, signal: request.signal };
      return {
        context: guarded.context,
        page,
        runStep: (step) => guarded.run(() => runFlowStep(step, scope)),
        assertAllowed: () => guarded.assertAllowed(),
        close: async () => {
          try {
            await guarded.close();
          } finally {
            lease.release();
          }
        },
      };
    } catch (error) {
      lease.release();
      throw error;
    }
  }
}

/** A context's trace, saved until the case's outcome says whether to attach it. */
interface SavedTrace {
  label: string;
  dir: string;
  /** Why stopping the trace failed, if it did. */
  failure: string | undefined;
}

function webSession(session: DriverSession): WebSession {
  if (!(session instanceof WebSession))
    throw new CaseBlocked("web steps run only in a session of the playwright driver");
  return session;
}

export const playwrightDriver = defineDriver({
  name: "playwright",
  surface: "web",
  probe: async (options) => {
    parseSettings(options);
    return CAPABILITIES;
  },
  launch: async (options) => {
    const settings = parseSettings(options);
    const lease = leaseBrowser(settings);
    try {
      const browser = await lease.browser;
      await assertMaskSelectorsParse(browser, options.redactor.selectors());
      return new WebSession(options, settings, browser, lease);
    } catch (error) {
      lease.release();
      throw error;
    }
  },
  steps,
});
