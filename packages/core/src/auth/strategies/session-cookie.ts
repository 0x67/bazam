import { isIP } from "node:net";
import { z } from "zod";
import { RequestStep } from "../../case/index.ts";
import type { PersonPrompt } from "../../challenge/index.ts";
import { bodyMismatches, type HttpResponse } from "../../driver/http.ts";
import type { BrowserLoginRequest, StorageState } from "../browser.ts";
import {
  defineAuthStrategy,
  IdentityMismatch,
  MissingHeaderCookie,
  type HttpRequestDraft,
} from "../strategy.ts";

const SCRIPTED_LOGIN_TIMEOUT_MS = 60_000;
export const PERSON_LOGIN_TIMEOUT_MS = 5 * 60_000;

const REQUEST_LINE = new RegExp(`^(${RequestStep.shape.method.options.join("|")})\\s+(\\S+)$`);
// session ids and JWTs are at least this long
const MIN_TOKEN_LENGTH = 16;
const TOKEN_CHARACTERS = /^[\w.~+/=%-]+$/;

/** A `METHOD url` line, such as `GET https://api.example.test/me`. */
const RequestLine = z.string().transform((line, ctx) => {
  const match = REQUEST_LINE.exec(line);
  if (match?.[1] === undefined || match[2] === undefined || !URL.canParse(match[2])) {
    ctx.addIssue({
      code: "custom",
      message: 'a request is a method and a URL, such as "GET ${env.API_URL}/me"',
    });
    return z.NEVER;
  }
  return { method: match[1], url: match[2] };
});

/**
 * A request whose answer counts as success when it has `status`, or any 2xx when that is left out, and, with
 * `body`, when each dot path holds the value written. It does not follow redirects, so a 3xx passes only when
 * `status` names it, and a dead session sent to a login page fails.
 */
export const RequestCheck = z.strictObject({
  request: RequestLine,
  status: z.number().int().optional(),
  /** Expected values by dot path inside the response body, as the api check reads them. */
  body: z.record(z.string(), z.unknown()).optional(),
});
export type RequestCheck = z.infer<typeof RequestCheck>;

export function requestDraft(check: RequestCheck): HttpRequestDraft {
  return {
    method: check.request.method,
    url: new URL(check.request.url),
    headers: new Headers(),
    redirect: "manual",
  };
}

/** False when the status is wrong; throws IdentityMismatch when the status is right and a body path holds another value. */
export function checkProbe(check: RequestCheck, response: HttpResponse): boolean {
  const statusOk =
    check.status === undefined
      ? response.status >= 200 && response.status < 300
      : response.status === check.status;
  if (!statusOk) return false;
  const paths = bodyMismatches(check.body ?? {}, response);
  if (paths.length > 0) throw new IdentityMismatch(paths);
  return true;
}

const HeaderValue = z.union([z.string(), z.strictObject({ cookie: z.string().min(1) })]);
const SessionRequest = RequestCheck.extend({
  headers: z
    .record(z.string().regex(/^[a-z0-9-]+$/i), HeaderValue)
    .refine((headers) => !Object.keys(headers).some((name) => name.toLowerCase() === "cookie"), {
      error:
        "the cookie header comes from the cached state; name the cookie under a header such as x-csrf-token",
    })
    .optional(),
});
type SessionRequest = z.infer<typeof SessionRequest>;

/** The request with its headers set: strings as written, `{ cookie }` from the cookie the state sends to the URL. */
function sessionRequestDraft(
  request: SessionRequest,
  state: StorageState,
  use: { identity: string; purpose: "probe" | "refresh" },
): HttpRequestDraft {
  const draft = requestDraft(request);
  const cookies = storedCookies(state).filter((cookie) => isSentTo(cookie, draft.url, Date.now()));
  for (const [header, value] of Object.entries(request.headers ?? {})) {
    if (typeof value === "string") {
      draft.headers.set(header, value);
      continue;
    }
    const cookie = cookies.find((entry) => entry.name === value.cookie);
    if (cookie === undefined) {
      throw new MissingHeaderCookie(
        use.purpose,
        use.identity,
        value.cookie,
        header,
        draft.url.origin,
      );
    }
    draft.headers.set(header, cookie.value);
  }
  setCookieHeader(draft, state);
  return draft;
}

const PersonLogin = z.strictObject({
  steps: z.array(z.string().min(1)).min(1),
  expected: z.string().min(1).optional(),
});
type PersonLogin = z.infer<typeof PersonLogin>;

/** What the person sees during a browser login. A login belongs to no case, and the strategy does not know the run. */
export function loginPrompt(
  strategy: string,
  identity: string,
  person: PersonLogin,
  timeoutMs: number,
): PersonPrompt {
  const prompt: PersonPrompt = {
    id: `${identity}-${strategy}-login`,
    runId: "",
    caseId: "",
    ask: "action",
    title: `Log in as ${identity}`,
    steps: person.steps,
    timeoutMs,
  };
  if (person.expected !== undefined) prompt.expected = person.expected;
  return prompt;
}

const SessionCookieConfig = z.strictObject({
  login: z.strictObject({
    url: z.url(),
    /** The flow that logs in; with `person`, it runs the steps before the person acts, such as entering the email. */
    flow: z.string().min(1).optional(),
    until: z.union([
      z.strictObject({ cookie: z.string().min(1) }),
      z.strictObject({ urlMatches: z.string().min(1) }),
    ]),
    person: PersonLogin.optional(),
    timeoutMs: z.number().int().positive().optional(),
  }),
  probe: SessionRequest.optional(),
  refresh: SessionRequest.optional(),
});
type SessionCookieConfig = z.infer<typeof SessionCookieConfig>;

const SAME_SITE = ["Strict", "Lax", "None"] as const;

/** A cookie as browser storage state writes it; a domain that starts with a dot also covers its subdomains. */
type BrowserCookie = {
  name: string;
  value: string;
  domain: string;
  path: string;
  /** Seconds since the epoch, or -1 for a session cookie. */
  expires: number;
  httpOnly: boolean;
  secure: boolean;
  sameSite: (typeof SAME_SITE)[number];
};

const StoredCookie = z.object({
  name: z.string(),
  value: z.string(),
  domain: z.string(),
  path: z.string().default("/"),
  expires: z.number().default(-1),
  httpOnly: z.boolean().default(false),
  secure: z.boolean().default(false),
});
type StoredCookie = z.infer<typeof StoredCookie>;

const StoredOrigin = z.object({
  localStorage: z.array(z.object({ value: z.string() })).default([]),
});

export const sessionCookieStrategy = defineAuthStrategy<SessionCookieConfig, StorageState>({
  name: "session-cookie",
  config: SessionCookieConfig,
  cacheable: true,
  needsPerson: (settings) => {
    const login = settings["login"];
    return typeof login === "object" && login !== null && "person" in login;
  },
  acquire: async ({ login }, ctx) => {
    if (ctx.browser === undefined)
      throw new Error(
        `the session-cookie login of ${ctx.identity} needs a driver that offers browser.login`,
      );
    const timeoutMs =
      login.timeoutMs ??
      (login.person === undefined ? SCRIPTED_LOGIN_TIMEOUT_MS : PERSON_LOGIN_TIMEOUT_MS);
    const request: BrowserLoginRequest = { url: new URL(login.url), until: login.until, timeoutMs };
    if (login.flow !== undefined) request.flow = [{ use: login.flow }];
    if (login.person !== undefined)
      request.prompt = loginPrompt("session-cookie", ctx.identity, login.person, timeoutMs);
    return (await ctx.browser.login(request)).state;
  },
  apply: async (state, target) => {
    if (target.kind === "browser") return target.session.loadStorageState(state);
    setCookieHeader(target.request, state);
  },
  probe: async (state, config, ctx) => {
    if (config.probe === undefined) return true;
    const draft = sessionRequestDraft(config.probe, state, {
      identity: ctx.identity,
      purpose: "probe",
    });
    return checkProbe(config.probe, await ctx.http.send(draft));
  },
  canRefresh: (_state, settings) => settings["refresh"] !== undefined,
  refresh: async (state, config, ctx) => {
    if (config.refresh === undefined)
      throw new Error(`the session-cookie settings of ${ctx.identity} have no refresh request`);
    const draft = sessionRequestDraft(config.refresh, state, {
      identity: ctx.identity,
      purpose: "refresh",
    });
    const response = await ctx.http.send(draft);
    if (!checkProbe(config.refresh, response))
      throw new Error(`the session refresh of ${ctx.identity} answered ${response.status}`);
    return storeSetCookies(state, draft.url, response.headers.getSetCookie(), ctx.now());
  },
  // a value a script can read counts only when it looks like a token, so lang=en-GB stays readable in evidence
  secrets: (state) => [
    ...storedCookies(state)
      .filter((cookie) => cookie.httpOnly || looksLikeToken(cookie.value))
      .map((cookie) => cookie.value),
    ...z
      .array(StoredOrigin)
      .parse(state.origins)
      .flatMap((origin) => origin.localStorage.flatMap((item) => stringsIn(item.value)))
      .filter(looksLikeToken),
  ],
});

/** A random value such as a session id or a JWT, as opposed to a word such as "accepted" or a URL. */
function looksLikeToken(value: string): boolean {
  return (
    value.length >= MIN_TOKEN_LENGTH &&
    TOKEN_CHARACTERS.test(value) &&
    /\d/.test(value) &&
    /[a-z]/i.test(value)
  );
}

/** The value, or every string inside it when it holds JSON, where SPAs keep tokens such as `{"accessToken": ...}`. */
function stringsIn(value: string): string[] {
  try {
    return jsonStrings(JSON.parse(value) as unknown);
  } catch {
    return [value];
  }
}

function jsonStrings(value: unknown): string[] {
  if (typeof value === "string") return [value];
  if (typeof value !== "object" || value === null) return [];
  return Object.values(value).flatMap(jsonStrings);
}

function storedCookies(state: StorageState): StoredCookie[] {
  return z.array(StoredCookie).parse(state.cookies);
}

/** Sets the Cookie header to the cookies a browser would send to the request's URL. */
function setCookieHeader(request: HttpRequestDraft, state: StorageState): void {
  const header = storedCookies(state)
    .filter((cookie) => isSentTo(cookie, request.url, Date.now()))
    .map((cookie) => `${cookie.name}=${cookie.value}`)
    .join("; ");
  if (header !== "") request.headers.set("cookie", header);
}

function isSentTo(cookie: StoredCookie, url: URL, nowMs: number): boolean {
  return (
    domainMatches(url.hostname, cookie.domain) &&
    pathMatches(url.pathname, cookie.path) &&
    (!cookie.secure || url.protocol === "https:") &&
    !isExpired(cookie.expires, nowMs)
  );
}

/** The state after the response's Set-Cookie headers: new cookies added, changed ones replaced, expired ones removed. */
function storeSetCookies(
  state: StorageState,
  url: URL,
  lines: readonly string[],
  now: Date,
): StorageState {
  let cookies = state.cookies;
  for (const line of lines) {
    const cookie = parseSetCookie(line, url, now);
    if (cookie === undefined) continue;
    cookies = cookies.filter((entry) => !isSameCookie(entry, cookie));
    if (!isExpired(cookie.expires, now.getTime())) cookies = [...cookies, cookie];
  }
  return { cookies, origins: state.origins };
}

function parseSetCookie(line: string, url: URL, now: Date): BrowserCookie | undefined {
  const [pair = "", ...attributes] = line.split(";");
  const equals = pair.indexOf("=");
  const name = pair.slice(0, equals).trim();
  if (equals < 0 || name === "") return undefined;
  const cookie: BrowserCookie = {
    name,
    value: pair.slice(equals + 1).trim(),
    domain: url.hostname,
    path: defaultPath(url),
    expires: -1,
    httpOnly: false,
    secure: false,
    sameSite: "Lax",
  };
  let maxAge: number | undefined;
  for (const attribute of attributes) {
    const [key = "", ...rest] = attribute.split("=");
    const value = rest.join("=").trim();
    switch (key.trim().toLowerCase()) {
      case "domain": {
        if (value === "") break;
        const domain = cookieDomain(value, url.hostname);
        if (domain === undefined) return undefined;
        cookie.domain = domain;
        break;
      }
      case "path":
        if (value.startsWith("/")) cookie.path = value;
        break;
      case "expires": {
        const time = Date.parse(value);
        if (!Number.isNaN(time)) cookie.expires = Math.floor(time / 1000);
        break;
      }
      case "max-age":
        if (/^-?\d+$/.test(value)) maxAge = Number(value);
        break;
      case "secure":
        cookie.secure = true;
        break;
      case "httponly":
        cookie.httpOnly = true;
        break;
      case "samesite":
        cookie.sameSite =
          SAME_SITE.find((sameSite) => sameSite.toLowerCase() === value.toLowerCase()) ??
          cookie.sameSite;
        break;
    }
  }
  // Max-Age wins over Expires
  if (maxAge !== undefined)
    cookie.expires = maxAge <= 0 ? 0 : Math.floor(now.getTime() / 1000) + maxAge;
  return cookie;
}

/**
 * Where a Domain attribute lets the cookie go, or undefined when the host may not set it there (RFC 6265 5.3).
 * A single label such as "test" stands in for a public suffix, which only a host of that name may use.
 */
function cookieDomain(attribute: string, host: string): string | undefined {
  const domain = attribute.replace(/^\./, "").toLowerCase();
  if (!domain.includes(".")) return domain === host ? host : undefined;
  return domainMatches(host, `.${domain}`) ? `.${domain}` : undefined;
}

function isSameCookie(entry: unknown, cookie: BrowserCookie): boolean {
  const stored = StoredCookie.safeParse(entry);
  return (
    stored.success &&
    stored.data.name === cookie.name &&
    stored.data.domain === cookie.domain &&
    stored.data.path === cookie.path
  );
}

function isExpired(expires: number, nowMs: number): boolean {
  return expires !== -1 && expires * 1000 <= nowMs;
}

// RFC 6265 section 5.1.3: an IP address matches only itself
function domainMatches(host: string, domain: string): boolean {
  const bare = domain.replace(/^\./, "");
  if (!domain.startsWith(".") || isIP(host) !== 0) return host === bare;
  return host === bare || host.endsWith(domain);
}

// RFC 6265 section 5.1.4
function pathMatches(requestPath: string, cookiePath: string): boolean {
  if (requestPath === cookiePath) return true;
  if (!requestPath.startsWith(cookiePath)) return false;
  return cookiePath.endsWith("/") || requestPath.charAt(cookiePath.length) === "/";
}

// the directory of the request path, which a cookie without Path is scoped to
function defaultPath(url: URL): string {
  const end = url.pathname.lastIndexOf("/");
  return end <= 0 ? "/" : url.pathname.slice(0, end);
}
