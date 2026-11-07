import { mkdtemp, readFile, rm } from "node:fs/promises";
import { connect } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import type { BrowserLogin, BrowserLoginRequest, BrowserSession, StorageState } from "@bazam/core/auth";
import { BRAND } from "@bazam/core/brand";
import { Selector, stepKind, type Step } from "@bazam/core/case";
import { ConnectionFailed, defineDriver, type Capability, type CaseEnding, type DriverSession, type LaunchOptions, type StepHandler } from "@bazam/core/driver";
import { assertHostAllowed, HostNotAllowed, type Environment } from "@bazam/core/env";
import type { Redactor } from "@bazam/core/redact";
import type { CheckRecord, EvidenceStore } from "@bazam/core/result";
import { chromium, firefox, webkit, type APIResponse, type Browser, type BrowserContext, type Locator, type Page, type Request, type Route } from "playwright";
import { z } from "zod";
import { PlaywrightLogin, storageStateOf, urlMatches, type LoginTab } from "./login.ts";
import { describeSelector, locate } from "./selectors.ts";
import { scrubTrace } from "./trace.ts";

// every Playwright in the peer range has BrowserContext.credentials, a virtual authenticator that works on every engine
const CAPABILITIES: ReadonlySet<Capability> = new Set(["browser.login", "webauthn.virtual"]);
const ENGINES = { chromium, firefox, webkit };
// cases run one after another, so a browser unused for this long is closed and the process can exit
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
    testIdAttribute: z.string().min(1).default("data-testid"),
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

function launchBrowser(kind: BrowserKind): Promise<Browser> {
  return ENGINES[kind.browser].launch({ headless: kind.headless, ...(kind.channel === undefined ? {} : { channel: kind.channel }) });
}

/** The first host refused in any of the contexts that share it, kept until a step throws it. */
class Refusals {
  #first: HostNotAllowed | undefined;
  #thrown = false;

  add(refusal: HostNotAllowed | undefined): void {
    this.#first ??= refusal;
  }

  /** Throws the first refusal, if there was one. */
  assertNone(): void {
    if (this.#first === undefined) return;
    this.#thrown = true;
    throw this.#first;
  }

  /** The first refusal, while no step has thrown it. */
  unthrown(): HostNotAllowed | undefined {
    return this.#thrown ? undefined : this.#first;
  }
}

/** A browser context whose main frames stay on the env's hosts, and whose extra headers go to those hosts alone. */
class GuardedContext {
  readonly context: BrowserContext;
  readonly #env: Environment;
  readonly #refusals: Refusals;
  readonly #engine: string | undefined;
  #page: Promise<Page> | undefined;
  #headers: Record<string, string> = {};

  private constructor(context: BrowserContext, env: Environment, refusals: Refusals) {
    this.context = context;
    this.#env = env;
    this.#refusals = refusals;
    this.#engine = context.browser()?.browserType().name();
  }

  static async open(context: BrowserContext, env: Environment, refusals: Refusals): Promise<GuardedContext> {
    const guarded = new GuardedContext(context, env, refusals);
    await context.route(() => true, (route) => guarded.#route(route));
    // routing misses redirect hops on Chromium and Firefox, so the page's URL is checked after each navigation too
    context.on("page", (page) => {
      // a popup appears once its first navigation has committed, and no framenavigated reports that one
      guarded.#checkNavigation(page.url());
      page.on("framenavigated", (frame) => {
        if (frame === page.mainFrame()) guarded.#checkNavigation(frame.url());
      });
    });
    return guarded;
  }

  page(): Promise<Page> {
    this.#page ??= this.context.newPage();
    return this.#page;
  }

  async setHeaders(headers: Record<string, string>): Promise<void> {
    // a response fulfilled from here has no address space, so Chromium would refuse the page's requests to loopback and private hosts
    if (this.#engine === "chromium") await this.context.grantPermissions(["local-network-access"]);
    for (const [name, value] of Object.entries(headers)) this.#headers[name.toLowerCase()] = value;
  }

  /** Throws the navigation the guard refused here or in a context sharing its refusals, if there was one. */
  assertAllowed(): void {
    this.#refusals.assertNone();
  }

  /** Runs a step's action; a refused navigation replaces whatever the action returned or threw. */
  async run(action: () => Promise<void>): Promise<void> {
    this.assertAllowed();
    try {
      await action();
    } catch (error) {
      this.assertAllowed();
      throw error;
    }
    this.assertAllowed();
  }

  async close(): Promise<void> {
    // a request still in a route handler would fail once the context is gone
    await this.context.unrouteAll({ behavior: "ignoreErrors" });
    await this.context.close();
  }

  async #route(route: Route): Promise<void> {
    const request = route.request();
    const refusal = hostRefusal(this.#env, new URL(request.url()));
    if (refusal === undefined) return Object.keys(this.#headers).length === 0 ? route.continue() : this.#sendWithHeaders(route);
    if (isMainFrameNavigation(request)) return this.#refuse(route, refusal);
    // a page may load fonts or scripts from other hosts; they just never get the extra headers
    return route.continue();
  }

  #refuse(route: Route, refusal: HostNotAllowed): Promise<void> {
    this.#refusals.add(refusal);
    return route.abort("blockedbyclient");
  }

  /**
   * Sends the request with the extra headers from here, since continue({ headers }) would also send them along every
   * redirect the browser follows. A redirect goes on without them.
   */
  async #sendWithHeaders(route: Route): Promise<void> {
    const request = route.request();
    let response: APIResponse;
    try {
      response = await route.fetch({ headers: { ...request.headers(), ...this.#headers }, maxRedirects: 0 });
      // WebKit takes no redirect from a route, so the request is followed from here and the page keeps its first URL
      if (isRedirect(response) && this.#engine === "webkit") {
        const hop = redirectHop(request, response);
        response = await this.context.request.fetch(hop.url, hop.options);
      }
    } catch {
      // the page sees the request fail, as it would had the browser sent it
      return route.abort("failed");
    }
    // so the guard checks where a redirect followed here landed
    const landing = hostRefusal(this.#env, new URL(response.url()));
    if (landing !== undefined && isMainFrameNavigation(request)) return this.#refuse(route, landing);
    return route.fulfill({ response });
  }

  #checkNavigation(href: string): void {
    // a popup whose first navigation the guard aborted can have no URL at all
    if (href === "") return;
    const url = new URL(href);
    // a new page starts at about:blank, and Chromium shows chrome-error: after the guard aborts a navigation
    if (url.protocol === "about:" || url.protocol === "chrome-error:") return;
    this.#refusals.add(hostRefusal(this.#env, url));
  }
}

const REDIRECT_STATUSES: ReadonlySet<number> = new Set([301, 302, 303, 307, 308]);
// the headers fetch drops when a redirect turns a request into a GET
const BODY_HEADERS = ["content-encoding", "content-language", "content-length", "content-location", "content-type"];

function isRedirect(response: APIResponse): boolean {
  return REDIRECT_STATUSES.has(response.status()) && response.headers()["location"] !== undefined;
}

interface RedirectHop {
  url: string;
  options: { method: string; headers: Record<string, string>; data?: Buffer };
}

/**
 * The request a redirect leads to, with the page's own headers and none of the extra ones, built the way fetch
 * builds it. Playwright's request client keeps to the same rules for any hop after it.
 */
function redirectHop(request: Request, redirect: APIResponse): RedirectHop {
  const from = new URL(request.url());
  const to = new URL(redirect.headers()["location"]!, from);
  const status = redirect.status();
  const method = request.method();
  const toGet = ((status === 301 || status === 302) && method === "POST") || (status === 303 && method !== "GET" && method !== "HEAD");
  // the request client adds the cookies and the host of the new URL itself
  const dropped = new Set(["host", "cookie", ...(to.origin === from.origin ? [] : ["authorization"]), ...(toGet ? BODY_HEADERS : [])]);
  const headers = Object.fromEntries(Object.entries(request.headers()).filter(([name]) => !dropped.has(name)));
  const body = request.postDataBuffer();
  if (toGet || body === null) return { url: to.href, options: { method: toGet ? "GET" : method, headers } };
  return { url: to.href, options: { method, headers, data: body } };
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
  return failure === undefined ? undefined : new ConnectionFailed(`GET ${url.origin}${url.pathname}`, failure.message, { cause: failure });
}

function hostRefusal(env: Environment, url: URL): HostNotAllowed | undefined {
  try {
    assertHostAllowed(env, url);
    return undefined;
  } catch (error) {
    if (error instanceof HostNotAllowed) return error;
    throw error;
  }
}

function isMainFrameNavigation(request: Request): boolean {
  if (!request.isNavigationRequest()) return false;
  try {
    return request.frame().parentFrame() === null;
  } catch {
    // frame() throws for a popup's first navigation, which starts before the popup's page exists
    return true;
  }
}

type PlaywrightStorageState = Exclude<Parameters<BrowserContext["setStorageState"]>[0], string>;
type Passkeys = Awaited<ReturnType<BrowserContext["credentials"]["get"]>>;

/** setStorageState also removes virtual passkeys and their authenticator, so the passkeys go back in with the state. */
async function loadStorageState(context: BrowserContext, state: StorageState): Promise<void> {
  const credentials = await context.credentials.get();
  // Playwright reads credentials in a storage state, which its type leaves out, and installs the authenticator for them
  const next: PlaywrightStorageState & { credentials?: Passkeys } =
    credentials.length === 0 ? (state as PlaywrightStorageState) : { ...(state as PlaywrightStorageState), credentials };
  await context.setStorageState(next);
}

/** What a web step acts on; a login has a page but no evidence. */
interface StepScope {
  page: Page;
  env: Environment;
  testIdAttribute: string;
  redactor: Redactor;
  evidence: EvidenceStore | undefined;
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

function caseEvidence(scope: StepScope, kind: string): EvidenceStore {
  if (scope.evidence === undefined) throw new Error(`a ${kind} step runs only inside a case, not in a browser login`);
  return scope.evidence;
}

const Expectation = z.union([
  z.strictObject({ visible: Selector }),
  z.strictObject({
    text: z.union([z.strictObject({ field: Selector, equals: z.string() }), z.strictObject({ field: Selector, contains: z.string() })]),
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
    await (press.field === undefined ? scope.page.keyboard.press(press.key) : field(scope, press.field).press(press.key));
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
    await evidence.attach(name, await scope.page.screenshot({ mask }), "png");
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
async function observe(expectation: Expectation, scope: StepScope): Promise<Pick<CheckRecord, "expected" | "observed" | "ok">> {
  if ("visible" in expectation) {
    const locator = field(scope, expectation.visible);
    const seen = await poll(() => locator.isVisible(), (visible) => visible);
    return { expected: "visible", observed: seen.value ? "visible" : "not visible", ok: seen.ok };
  }
  if ("url" in expectation) {
    const seen = await poll(async () => scope.page.url(), (url) => urlMatches(expectation.url, url));
    return { expected: expectation.url, observed: seen.value, ok: seen.ok };
  }
  const text = expectation.text;
  const locator = field(scope, text.field);
  const matches = (observed: string): boolean =>
    "equals" in text ? observed === normalizeSpace(text.equals) : observed.includes(normalizeSpace(text.contains));
  const seen = await poll(async () => normalizeSpace((await locator.allTextContents()).join(" ")), matches);
  return { expected: "equals" in text ? { equals: text.equals } : { contains: text.contains }, observed: seen.value, ok: seen.ok };
}

async function poll<T>(read: () => Promise<T>, ok: (value: T) => boolean): Promise<{ value: T; ok: boolean }> {
  const deadline = Date.now() + EXPECT_TIMEOUT_MS;
  for (;;) {
    const value = await read();
    if (ok(value)) return { value, ok: true };
    if (Date.now() >= deadline) return { value, ok: false };
    await sleep(EXPECT_POLL_MS);
  }
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
    try {
      const keepTraces = ending.status !== "pass" || this.#refusals.unthrown() !== undefined;
      const several = this.#contexts.size > 1;
      for (const [identity, opening] of this.#contexts) {
        // a context that failed to open already failed the step that asked for it
        const guarded = await opening.catch(() => undefined);
        if (guarded === undefined) continue;
        const label = several ? `trace-${identity ?? "anonymous"}` : "trace";
        if (keepTraces) await this.#keepTrace(guarded.context, label, ending.evidence);
        await guarded.close();
      }
    } finally {
      this.#contexts.clear();
      this.#lease.release();
    }
    const late = this.#refusals.unthrown();
    if (late !== undefined) throw late;
  }

  async #openCaseContext(): Promise<GuardedContext> {
    const context = await this.#browser.newContext();
    // screencast frames are images the scrubber cannot read, and sources would copy test files into the zip
    await context.tracing.start({ snapshots: true, screenshots: false, sources: false });
    return GuardedContext.open(context, this.#env, this.#refusals);
  }

  /** Attaches the scrubbed trace; when stopping or scrubbing fails, notes why and attaches nothing. */
  async #keepTrace(context: BrowserContext, label: string, evidence: EvidenceStore): Promise<void> {
    // outside runs/, so the unscrubbed zip never sits beside the evidence
    const dir = await mkdtemp(join(tmpdir(), `${BRAND.name}-trace-`));
    try {
      const file = join(dir, "trace.zip");
      await context.tracing.stop({ path: file });
      await evidence.attach(label, scrubTrace(await readFile(file), this.redactor), "zip");
    } catch (error) {
      evidence.note(`${label}.zip was left out: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
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

function webSession(session: DriverSession): WebSession {
  if (!(session instanceof WebSession)) throw new Error("web steps run only in a session of the playwright driver");
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
      return new WebSession(options, settings, await lease.browser, lease);
    } catch (error) {
      lease.release();
      throw error;
    }
  },
  steps,
});
