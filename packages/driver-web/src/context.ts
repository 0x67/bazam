import type { BrowserSession } from "@bazam/core/auth";
import { assertHostAllowed, HostNotAllowed, type Environment } from "@bazam/core/env";
import type { APIResponse, BrowserContext, Page, Request, Response, Route } from "playwright";

/** The first host refused in any of the contexts that share it, kept until a step throws it. */
export class Refusals {
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

/** A browser context whose main frames stay on the env's hosts, and whose extra headers and HTTP credentials go to those hosts alone. */
export class GuardedContext {
  readonly context: BrowserContext;
  readonly #env: Environment;
  readonly #refusals: Refusals;
  readonly #engine: string | undefined;
  #page: Promise<Page> | undefined;
  #headers: Record<string, string> = {};
  #credentials: HttpCredentials | undefined;
  // allowlisted origins, written as URL.origin writes them, whose challenges the credentials answer
  readonly #credentialOrigins = new Set<string>();
  #credentialsSet: Promise<void> = Promise.resolve();
  // the Basic header WebKit sends to allowlisted hosts, since it answers no challenge from http on 80 or https on 443
  #authorization: string | undefined;

  private constructor(context: BrowserContext, env: Environment, refusals: Refusals) {
    this.context = context;
    this.#env = env;
    this.#refusals = refusals;
    this.#engine = context.browser()?.browserType().name();
  }

  static async open(context: BrowserContext, env: Environment, refusals: Refusals): Promise<GuardedContext> {
    const guarded = new GuardedContext(context, env, refusals);
    await context.route(
      () => true,
      (route) => guarded.#route(route),
    );
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

  async setCredentials(credentials: HttpCredentials): Promise<void> {
    // WebKit compares a challenge's port with the origin's, which is empty for http on 80 and https on 443, so it
    // matches no credentials there; the header also goes on each request to an allowlisted host. A WebSocket
    // handshake never reaches a route, so WebKit leaves its challenge from such an origin unanswered
    if (this.#engine === "webkit") {
      this.#authorization = `Basic ${Buffer.from(`${credentials.username}:${credentials.password}`, "utf8").toString("base64")}`;
    }
    this.#credentials = { ...credentials };
    for (const host of this.#env.hosts) {
      this.#credentialOrigins.add(new URL(`http://${host}`).origin);
      this.#credentialOrigins.add(new URL(`https://${host}`).origin);
    }
    this.#credentialsSet = this.#applyCredentials(this.#credentials);
    await this.#credentialsSet;
  }

  /**
   * Calls `listener` with the origin of each 401 answer to a fetch or XHR request to an allowlisted host; returns a
   * function that stops it. Document navigations, which carry form answers, are left out.
   */
  onUnauthorized(listener: (origin: string) => void): () => void {
    const onResponse = (response: Response): void => {
      if (response.status() !== 401 || !FETCH_TYPES.has(response.request().resourceType())) return;
      // Firefox reports the Basic challenge it then answers with the HTTP credentials; its retry carries the header,
      // and a request sent from a route never shows it the challenge
      if (
        this.#engine === "firefox" &&
        this.#credentials !== undefined &&
        Object.keys(this.#headers).length === 0 &&
        response.request().headers()["authorization"] === undefined &&
        BASIC_SCHEME.test(response.headers()["www-authenticate"] ?? "")
      )
        return;
      const url = new URL(response.url());
      if (hostRefusal(this.#env, url) === undefined) listener(url.origin);
    };
    this.context.on("response", onResponse);
    return () => {
      this.context.off("response", onResponse);
    };
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
    // a navigation the page started can reach the browser only after the route is gone, as when WebKit loads another
    // site in a new process; offline it then fails without a route, and only its request event shows it
    this.context.on("request", (request) => {
      if (isMainFrameNavigation(request)) this.#checkNavigation(request.url());
    });
    // WebKit sends a request still paused in a route once its page goes, and unrouting lets the rest through
    await this.context.setOffline(true);
    // a request still in a route handler would fail once the context is gone
    await this.context.unrouteAll({ behavior: "ignoreErrors" });
    // that navigation's new process resumes as unrouting ends, and answers this call only after it sends the request
    await this.context.setOffline(true);
    await this.context.close();
  }

  async #route(route: Route): Promise<void> {
    const request = route.request();
    const url = new URL(request.url());
    const refusal = hostRefusal(this.#env, url);
    if (refusal === undefined) {
      await this.#answerChallengesFrom(url.origin);
      if (Object.keys(this.#headers).length > 0) return this.#sendWithHeaders(route);
      if (this.#authorization === undefined) return route.continue();
      // WebKit keeps the header on a same-origin redirect and drops it on a cross-origin one, so a hop to another
      // allowlisted host goes without credentials; an Authorization header the page set itself wins
      return route.continue({
        headers: { ...request.headers(), authorization: request.headers()["authorization"] ?? this.#authorization },
      });
    }
    if (isMainFrameNavigation(request)) return this.#refuse(route, refusal);
    // a page may load fonts or scripts from other hosts; they just never get the extra headers
    return route.continue();
  }

  /**
   * Adds an allowlisted origin, such as one on a port other than the default, to those the credentials answer.
   * Chromium and Firefox route no redirect hop, so a hop to such an origin that was never routed goes unanswered.
   */
  async #answerChallengesFrom(origin: string): Promise<void> {
    if (this.#credentials === undefined) return;
    if (!this.#credentialOrigins.has(origin)) {
      this.#credentialOrigins.add(origin);
      this.#credentialsSet = this.#applyCredentials(this.#credentials);
    }
    // a request to an origin another request just added waits until the browser has it too
    await this.#credentialsSet;
  }

  #applyCredentials(credentials: HttpCredentials): Promise<void> {
    // an entry without an origin would answer a challenge from any host
    const entries = [...this.#credentialOrigins].map((origin) => ({ ...credentials, origin }));
    // a trace records each call with its params, where the scrubber masks only registered values, but leaves out
    // Playwright's internal calls, and Playwright has no public way to make one
    const client = this.context as unknown as PlaywrightClient;
    return client._wrapApiCall(() => this.context.setHTTPCredentials(entries), { internal: true });
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
      const authorization = this.#authorization === undefined ? {} : { authorization: this.#authorization };
      response = await route.fetch({
        headers: { ...authorization, ...request.headers(), ...this.#headers },
        maxRedirects: 0,
      });
      // WebKit takes no redirect from a route, so the request is followed from here and the page keeps its first URL
      if (isRedirect(response) && this.#engine === "webkit") {
        const hop = redirectHop(request, response, this.#authorization);
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

type HttpCredentials = Parameters<BrowserSession["setHttpCredentials"]>[0];

/** The private method a Playwright client object runs each of its calls through. */
interface PlaywrightClient {
  _wrapApiCall<T>(call: () => Promise<T>, options: { internal: boolean }): Promise<T>;
}

const FETCH_TYPES: ReadonlySet<string> = new Set(["fetch", "xhr"]);
const BASIC_SCHEME = /(?:^|,)\s*basic\b/i;
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
function redirectHop(request: Request, redirect: APIResponse, authorization: string | undefined): RedirectHop {
  const from = new URL(request.url());
  const to = new URL(redirect.headers()["location"]!, from);
  const status = redirect.status();
  const method = request.method();
  const toGet =
    ((status === 301 || status === 302) && method === "POST") ||
    (status === 303 && method !== "GET" && method !== "HEAD");
  // the request client adds the cookies and the host of the new URL itself
  const dropped = new Set([
    "host",
    "cookie",
    ...(to.origin === from.origin ? [] : ["authorization"]),
    ...(toGet ? BODY_HEADERS : []),
  ]);
  const headers = Object.fromEntries(Object.entries(request.headers()).filter(([name]) => !dropped.has(name)));
  // basic credentials stay on a same-origin hop, as they do on a redirect WebKit follows itself, unless the page set its own
  if (authorization !== undefined && to.origin === from.origin) headers["authorization"] ??= authorization;
  const body = request.postDataBuffer();
  if (toGet || body === null) return { url: to.href, options: { method: toGet ? "GET" : method, headers } };
  return { url: to.href, options: { method, headers, data: body } };
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
