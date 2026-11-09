import { isDeepStrictEqual } from "node:util";
import { z } from "zod";
import type { HttpRequestDraft, Identities } from "../auth/index.ts";
import { RequestStep } from "../case/index.ts";
import { assertHostAllowed, assertProdWrite, type Environment } from "../env/index.ts";
import type { Redactor } from "../redact/index.ts";
import type { CheckRecord } from "../result/index.ts";
import type { StepContext, StepHandler } from "./driver.ts";

const API_SURFACE = "api";
// the limit fetch uses
const MAX_REDIRECTS = 20;
const REDIRECT_STATUSES: ReadonlySet<number> = new Set([301, 302, 303, 307, 308]);
// fetch drops these when a redirect leaves the origin
const CREDENTIAL_HEADERS = ["authorization", "cookie", "proxy-authorization"];
const REQUEST_LINE = new RegExp(`^(${RequestStep.shape.method.options.join("|")})\\s+(\\S.*)$`);
// the runner puts the case id and title in StepContext.values under these names
const CASE_VALUES: ReadonlySet<string> = new Set(["id", "title"]);

export interface HttpResponse {
  status: number;
  headers: Headers;
  /** The parsed JSON for a JSON content type, otherwise the text; undefined for an empty body. */
  body: unknown;
}

export interface GuardedHttp {
  /** Sends with the identity's credential for the surface applied, or with none when `as` is left out. */
  send(request: HttpRequestDraft, as?: { identity: string; surface: string }): Promise<HttpResponse>;
}

export interface GuardedHttpDeps {
  /** Every request and redirect must stay on its hosts. */
  env: Environment;
  redactor: Redactor;
  /** Gets one line per request, with no header value and every query value masked. */
  log(line: string): void;
  /** Left out for a client that never sends credentials, such as the one auth strategies get. */
  identities?: Pick<Identities, "authorize" | "recoverFromUnauthorized">;
}

/** The server answered 401 to an identity's credential, even after a refresh where one was possible. */
export class Unauthorized extends Error {
  constructor(identity: string, surface: string, target: string) {
    super(`${target} answered 401 to the ${surface} credential of ${identity}`);
    this.name = "Unauthorized";
  }
}

/** The request never reached the server, as when the host refuses the connection or its name does not resolve. */
export class ConnectionFailed extends Error {
  constructor(target: string, reason: string, options?: ErrorOptions) {
    super(`${target} got no answer: ${reason}`, options);
    this.name = "ConnectionFailed";
  }
}

// errors from before the request was sent; a connection dropped after that is the server's doing
const CONNECT_ERROR_CODES: ReadonlySet<string> = new Set([
  "ECONNREFUSED",
  "ENOTFOUND",
  "EAI_AGAIN",
  "EHOSTUNREACH",
  "ENETUNREACH",
  "ETIMEDOUT",
  "UND_ERR_CONNECT_TIMEOUT",
]);

function connectFailure(target: string, error: unknown): ConnectionFailed | undefined {
  // fetch rejects a failed connection with a TypeError whose cause is the socket error
  if (!(error instanceof TypeError) || !(error.cause instanceof Error)) return undefined;
  const cause = error.cause as NodeJS.ErrnoException;
  if (cause.code === undefined || !CONNECT_ERROR_CODES.has(cause.code)) return undefined;
  // a name with several addresses fails with an AggregateError whose message is empty but whose code is set
  return new ConnectionFailed(target, cause.message || cause.code, { cause: error });
}

type Authorize = (request: HttpRequestDraft) => Promise<void>;

export function guardedHttp(deps: GuardedHttpDeps): GuardedHttp {
  return {
    async send(request, as) {
      if (as === undefined) return follow(deps, request, undefined);
      const identities = deps.identities;
      if (identities === undefined)
        throw new Error(`this HTTP client sends no credentials, so it cannot send as ${as.identity}`);
      const authorize: Authorize = (draft) =>
        identities.authorize(as.identity, as.surface, { kind: "http", request: draft });
      const response = await follow(deps, request, authorize);
      if (response.status !== 401) return response;
      if (await identities.recoverFromUnauthorized(as.identity, as.surface)) {
        const retried = await follow(deps, request, authorize);
        if (retried.status !== 401) return retried;
      }
      throw new Unauthorized(as.identity, as.surface, describeRequest(request));
    },
  };
}

/** Follows redirects by hand so each hop is checked against the env's hosts. */
async function follow(
  deps: GuardedHttpDeps,
  request: HttpRequestDraft,
  authorize: Authorize | undefined,
): Promise<HttpResponse> {
  let hop = request;
  for (let redirects = 0; ; redirects += 1) {
    assertHostAllowed(deps.env, hop.url);
    const response = await sendHop(deps, hop, hop.url.origin === request.url.origin ? authorize : undefined);
    const location = response.headers.get("location");
    if (request.redirect === "manual" || !REDIRECT_STATUSES.has(response.status) || location === null)
      return readResponse(response);
    await response.body?.cancel();
    if (redirects === MAX_REDIRECTS)
      throw new Error(`${describeRequest(request)} redirected more than ${MAX_REDIRECTS} times`);
    hop = redirected(hop, response.status, new URL(location, hop.url));
  }
}

async function sendHop(
  deps: GuardedHttpDeps,
  hop: HttpRequestDraft,
  authorize: Authorize | undefined,
): Promise<Response> {
  // a strategy may set headers or a query parameter, and the caller's draft is sent again after a refresh
  const draft: HttpRequestDraft = { ...hop, url: new URL(hop.url), headers: new Headers(hop.headers) };
  if (authorize !== undefined) await authorize(draft);
  // the copy is backed by an ArrayBuffer, which fetch takes; the draft's bytes may sit in a SharedArrayBuffer
  const body = draft.body === undefined ? null : new Uint8Array(draft.body);
  const init: RequestInit = {
    method: draft.method,
    headers: draft.headers,
    body,
    redirect: "manual",
    signal: draft.signal ?? null,
  };
  // an abort rejects with the signal's reason, a DOMException that connectFailure passes through
  const response = await fetch(draft.url, init).catch((error: unknown) => {
    throw connectFailure(describeRequest(draft), error) ?? error;
  });
  deps.log(deps.redactor.text(`${describeRequest(draft)} ${response.status}`));
  return response;
}

/** The request a redirect leads to, changed the way fetch changes it. */
function redirected(hop: HttpRequestDraft, status: number, url: URL): HttpRequestDraft {
  const headers = new Headers(hop.headers);
  if (url.origin !== hop.url.origin) for (const name of CREDENTIAL_HEADERS) headers.delete(name);
  const method = hop.method.toUpperCase();
  const toGet = status === 303 ? method !== "HEAD" : (status === 301 || status === 302) && method === "POST";
  if (!toGet) return { ...hop, url, headers };
  headers.delete("content-type");
  return { method: "GET", url, headers, ...(hop.signal === undefined ? {} : { signal: hop.signal }) };
}

async function readResponse(response: Response): Promise<HttpResponse> {
  return {
    status: response.status,
    headers: response.headers,
    body: parseBody(await response.text(), response.headers.get("content-type")),
  };
}

function parseBody(text: string, contentType: string | null): unknown {
  if (text === "") return undefined;
  if (!/\bjson\b/i.test(contentType ?? "")) return text;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    // a broken body then fails the check that reads it, as any wrong answer does
    return text;
  }
}

/** Method and URL for logs and errors, with every query value masked. */
function describeRequest(request: Pick<HttpRequestDraft, "method" | "url">): string {
  const query = [...request.url.searchParams.keys()].map((key) => `${key}=[redacted]`).join("&");
  return `${request.method} ${request.url.origin}${request.url.pathname}${query === "" ? "" : `?${query}`}`;
}

const ApiCheck = z
  .strictObject({
    request: z
      .string()
      .regex(REQUEST_LINE, { error: 'a request is a method and a URL, such as "GET ${env.API_URL}/me"' }),
    as: z.string().min(1).optional(),
    write: z.boolean().optional(),
    status: z.number().int().optional(),
    /** Expected values by dot path inside the response body, such as `items[0].id`. */
    body: z.record(z.string(), z.unknown()).optional(),
  })
  .refine((check) => check.status !== undefined || check.body !== undefined, {
    error: "an api check names a status, body paths or both",
  });
type ApiCheck = z.infer<typeof ApiCheck>;

const RequestStepPayload = RequestStep.refine(
  (step) => Object.keys(step.save ?? {}).every((name) => !CASE_VALUES.has(name)),
  {
    path: ["save"],
    error: "save cannot use the names id and title, which hold the case's own ${case.id} and ${case.title}",
  },
);

const requestStep: StepHandler<RequestStep> = {
  kind: "request",
  schema: RequestStepPayload,
  async run(written, ctx) {
    const step = await ctx.resolve(written);
    assertProdWrite(ctx.env, step.method, step);
    const draft: HttpRequestDraft = {
      method: step.method,
      url: new URL(step.url),
      headers: new Headers(step.headers),
      signal: ctx.signal,
    };
    if (step.json !== undefined) {
      if (!draft.headers.has("content-type")) draft.headers.set("content-type", "application/json");
      draft.body = new TextEncoder().encode(JSON.stringify(step.json));
    }
    const response = await ctx.http.send(draft, actingIdentity(step.as, ctx));
    for (const [name, path] of Object.entries(step.save ?? {})) ctx.values.set(name, savedValue(response, path));
  },
};

const apiCheck: StepHandler<ApiCheck> = {
  kind: "api",
  schema: ApiCheck,
  async run(written, ctx) {
    const check = await ctx.resolve(written);
    const { method, url } = requestLine(check.request);
    assertProdWrite(ctx.env, method, check);
    const response = await ctx.http.send(
      { method, url, headers: new Headers(), signal: ctx.signal },
      actingIdentity(check.as, ctx),
    );
    // the name keeps the placeholders as written, so it never holds a resolved secret
    ctx.evidence.record({ name: written.request, kind: "api", ...compare(check, response) });
  },
};

/** The `request` step and the `api` check. */
export const httpSteps: readonly StepHandler[] = [requestStep, apiCheck];

/** The identity the payload names, else the step's, on the api surface; none when neither names one. */
function actingIdentity(
  named: string | undefined,
  ctx: StepContext,
): { identity: string; surface: string } | undefined {
  const identity = named ?? ctx.identity;
  return identity === undefined ? undefined : { identity, surface: API_SURFACE };
}

function requestLine(line: string): { method: string; url: URL } {
  const match = REQUEST_LINE.exec(line);
  if (match?.[1] === undefined || match[2] === undefined)
    throw new Error(`"${line}" is not a method followed by a URL`);
  return { method: match[1], url: new URL(match[2]) };
}

function savedValue(response: HttpResponse, path: string): string {
  const value = valueAt(response, path);
  if (value === undefined) throw new Error(`cannot save ${path}: the ${response.status} response has no value there`);
  return typeof value === "string" ? value : JSON.stringify(value);
}

function compare(check: ApiCheck, response: HttpResponse): Pick<CheckRecord, "expected" | "observed" | "ok"> {
  const expected: Record<string, unknown> = {};
  const observed: Record<string, unknown> = {};
  if (check.status !== undefined) {
    expected["status"] = check.status;
    observed["status"] = response.status;
  }
  for (const [path, value] of Object.entries(check.body ?? {})) {
    expected[`body.${path}`] = value;
    observed[`body.${path}`] = valueAt(response, `body.${path}`);
  }
  const ok = Object.entries(expected).every(([path, value]) => matches(value, observed[path]));
  return { expected, observed, ok };
}

// placeholders resolve to text, so "${case.orderId}" has to match the number 42
function matches(expected: unknown, observed: unknown): boolean {
  if (typeof expected === "string" && (typeof observed === "number" || typeof observed === "boolean"))
    return String(observed) === expected;
  return isDeepStrictEqual(expected, observed);
}

/** Reads `status`, `headers.<name>` or a path under `body` with array indexes, such as `body.items[0].id`. */
function valueAt(response: HttpResponse, path: string): unknown {
  const [root, ...rest] = pathSegments(path);
  if (root === "status" && rest.length === 0) return response.status;
  if (root === "headers" && rest.length === 1 && typeof rest[0] === "string")
    return response.headers.get(rest[0]) ?? undefined;
  if (root === "body") return rest.reduce<unknown>((value, key) => child(value, key), response.body);
  throw new Error(`${path} is not status, headers.<name> or a path under body`);
}

function pathSegments(path: string): (string | number)[] {
  return path.split(".").flatMap((part) => {
    const match = /^([^[\]]*)((?:\[\d+\])*)$/.exec(part);
    const name = match?.[1];
    const indexes = match?.[2];
    if (name === undefined || indexes === undefined || (name === "" && indexes === "")) {
      throw new Error(`${path} is not a dot path such as body.items[0].id`);
    }
    return [...(name === "" ? [] : [name]), ...[...indexes.matchAll(/\d+/g)].map((index) => Number(index[0]))];
  });
}

function child(value: unknown, key: string | number): unknown {
  if (typeof key === "number") return Array.isArray(value) ? value[key] : undefined;
  if (typeof value !== "object" || value === null || Array.isArray(value) || !Object.hasOwn(value, key))
    return undefined;
  return (value as Record<string, unknown>)[key];
}
