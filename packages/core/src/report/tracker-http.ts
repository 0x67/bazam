import type { Redactor } from "../redact/index.ts";

const MAX_REDIRECTS = 5;
const REDIRECT_STATUSES: ReadonlySet<number> = new Set([301, 302, 303, 307, 308]);
const MAX_ATTEMPTS = 4;
const FIRST_WAIT_MS = 1000;
const MAX_WAIT_MS = 60_000;
const LOOPBACK_HOSTS: ReadonlySet<string> = new Set(["127.0.0.1", "localhost"]);
const UNAUTHORIZED_HINT =
  "; check that the API token has not expired, and for a scoped token set trackers.<tracker>.api";

export interface TrackerRequest {
  method: string;
  /** Starts with `/` and joins onto the base path; {@link trackerPath} encodes its parameters. */
  path: string;
  query?: Record<string, string>;
  json?: unknown;
  form?: FormData;
  headers?: Record<string, string>;
  /** Returns the first redirect's `Location` as {@link TrackerResponse.location} instead of following it. */
  redirect?: "report";
}

export interface TrackerResponse {
  status: number;
  headers: Headers;
  /** The parsed JSON for a JSON content type, otherwise the text; undefined for an empty body. */
  body: unknown;
  /** The `Location` of the redirect a `redirect: "report"` request got; the redirect is not followed. */
  location?: string;
}

export interface TrackerHttp {
  /** Throws {@link TrackerRequestFailed} on a final status outside 2xx. */
  send(request: TrackerRequest): Promise<TrackerResponse>;
}

export interface TrackerHttpOptions {
  /** https, or http on 127.0.0.1 or localhost with a port; may hold a path. */
  base: URL;
  /** The whole header value, such as `Basic <base64>`. */
  authorization: string;
  redactor: Redactor;
  signal: AbortSignal;
  /** Gets `<METHOD> <path>` per request and one line per retry wait, masked. */
  log(line: string): void;
  fetch?: typeof fetch;
}

/** The tracker answered outside 2xx; the message is masked. */
export class TrackerRequestFailed extends Error {
  readonly status: number;

  constructor(message: string, status: number) {
    super(message);
    this.name = "TrackerRequestFailed";
    this.status = status;
  }
}

/** Joins the literal parts with each parameter passed through `encodeURIComponent`. */
export function trackerPath(parts: TemplateStringsArray, ...params: readonly string[]): string {
  return parts.reduce(
    (path, part, index) => path + encodeURIComponent(params[index - 1] ?? "") + part,
  );
}

/** Registers the credential with the redactor and refuses a base that is not https, before any request. */
export function trackerHttp(options: TrackerHttpOptions): TrackerHttp {
  const { base, redactor, signal } = options;
  const loopback =
    base.protocol === "http:" && LOOPBACK_HOSTS.has(base.hostname) && base.port !== "";
  if (base.protocol !== "https:" && !loopback)
    throw new Error(
      `tracker base ${base.origin} is not https; http is only for 127.0.0.1 or localhost with a port`,
    );
  registerCredential(redactor, options.authorization);
  const basePath = base.pathname.replace(/\/$/, "");
  const fetchFn = options.fetch ?? fetch;
  const log = (line: string): void => options.log(redactor.text(line));
  // relative to the base, for logs
  const shown = (url: URL): string =>
    url.pathname.startsWith(`${basePath}/`) ? url.pathname.slice(basePath.length) : url.pathname;

  async function follow(method: string, request: TrackerRequest, url: URL): Promise<Response> {
    let hop = { method, url, body: requestBody(request) };
    for (let redirects = 0; ; redirects += 1) {
      log(`${hop.method} ${shown(hop.url)}`);
      const response = await fetchFn(hop.url, {
        method: hop.method,
        headers: requestHeaders(request, options.authorization, hop.body),
        body: hop.body ?? null,
        redirect: "manual",
        signal,
      });
      const location = response.headers.get("location");
      if (!REDIRECT_STATUSES.has(response.status) || location === null) return response;
      if (request.redirect === "report") return response;
      await response.body?.cancel();
      const next = new URL(location, hop.url);
      if (next.origin !== base.origin)
        throw new Error(
          redactor.text(
            `${method} ${request.path} redirected to ${next.origin}, which is not the tracker`,
          ),
        );
      if (redirects === MAX_REDIRECTS)
        throw new Error(
          redactor.text(`${method} ${request.path} redirected more than ${MAX_REDIRECTS} times`),
        );
      // as fetch does: 303 turns into GET, and so does a POST answered 301 or 302
      const toGet =
        response.status === 303
          ? hop.method !== "HEAD"
          : (response.status === 301 || response.status === 302) && hop.method === "POST";
      hop = toGet ? { method: "GET", url: next, body: undefined } : { ...hop, url: next };
    }
  }

  return {
    async send(request) {
      const method = request.method.toUpperCase();
      const url = requestUrl(base, basePath, method, request);
      for (let attempt = 1; ; attempt += 1) {
        const response = await follow(method, request, url);
        const redirected = response.headers.get("location");
        if (
          request.redirect === "report" &&
          redirected !== null &&
          REDIRECT_STATUSES.has(response.status)
        ) {
          await response.body?.cancel();
          return {
            status: response.status,
            headers: response.headers,
            body: undefined,
            location: redirected,
          };
        }
        const retry = response.status === 429 || (response.status === 503 && method === "GET");
        if (!retry || attempt === MAX_ATTEMPTS)
          return readResponse(response, method, request.path, redactor);
        await response.body?.cancel();
        const ms = waitMs(response.headers.get("retry-after"), attempt);
        log(
          `${method} ${request.path} answered ${response.status}; retrying in ${Number((ms / 1000).toFixed(1))} s`,
        );
        await wait(ms, signal);
      }
    },
  };
}

// the header, the part after its scheme word and, for basic auth, the token after the email
function registerCredential(redactor: Redactor, authorization: string): void {
  redactor.register(authorization);
  const space = authorization.indexOf(" ");
  if (space === -1) return;
  const credential = authorization.slice(space + 1).trim();
  redactor.register(credential);
  if (authorization.slice(0, space).toLowerCase() !== "basic") return;
  const decoded = Buffer.from(credential, "base64").toString("utf8");
  const colon = decoded.indexOf(":");
  if (colon !== -1) redactor.register(decoded.slice(colon + 1));
}

function requestUrl(base: URL, basePath: string, method: string, request: TrackerRequest): URL {
  // the URL parser drops tabs and newlines, and reads %2e as a dot and a backslash as a slash
  if (
    request.path
      .replace(/[\t\n\r]/g, "")
      .split(/[/\\]/)
      .some((segment) => /^(?:\.|%2e){1,2}$/i.test(segment))
  )
    throw new Error(`${method} ${request.path} has a . or .. segment`);
  const url = new URL(base);
  url.pathname = basePath + request.path;
  if (!url.pathname.startsWith(`${basePath}/`))
    throw new Error(
      `${method} ${request.path} resolves outside the tracker base path ${basePath || "/"}`,
    );
  url.search = request.query === undefined ? "" : new URLSearchParams(request.query).toString();
  url.hash = "";
  return url;
}

function requestBody(request: TrackerRequest): string | FormData | undefined {
  if (request.form !== undefined) return request.form;
  return request.json === undefined ? undefined : JSON.stringify(request.json);
}

function requestHeaders(
  request: TrackerRequest,
  authorization: string,
  body: string | FormData | undefined,
): Headers {
  const headers = new Headers(request.headers);
  headers.set("authorization", authorization);
  if (!headers.has("accept")) headers.set("accept", "application/json");
  // fetch writes the multipart content type with its boundary itself
  if (typeof body === "string") headers.set("content-type", "application/json");
  return headers;
}

async function readResponse(
  response: Response,
  method: string,
  path: string,
  redactor: Redactor,
): Promise<TrackerResponse> {
  const body = parseBody(await response.text(), response.headers.get("content-type"));
  if (response.status >= 200 && response.status < 300)
    return { status: response.status, headers: response.headers, body };
  const detail = firstError(body);
  let message =
    `${method} ${path} answered ${response.status}` + (detail === undefined ? "" : `: ${detail}`);
  if (response.status === 401) message = message.replace(/\.$/, "") + UNAUTHORIZED_HINT;
  throw new TrackerRequestFailed(redactor.text(message), response.status);
}

function parseBody(text: string, contentType: string | null): unknown {
  if (text === "") return undefined;
  if (!/\bjson\b/i.test(contentType ?? "")) return text;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return text;
  }
}

// the first `errorMessages` entry, else the first `errors` value, as Jira answers
function firstError(body: unknown): string | undefined {
  if (typeof body !== "object" || body === null) return undefined;
  const { errorMessages, errors } = body as { errorMessages?: unknown; errors?: unknown };
  const messages: unknown[] = [
    ...(Array.isArray(errorMessages) ? errorMessages : []),
    ...(typeof errors === "object" && errors !== null ? Object.values(errors) : []),
  ];
  return messages.find((message): message is string => typeof message === "string");
}

// Retry-After when given, else 1 s doubling per attempt times a factor from 0.7 to 1.3
function waitMs(retryAfter: string | null, attempt: number): number {
  const ms =
    retryAfterMs(retryAfter) ?? FIRST_WAIT_MS * 2 ** (attempt - 1) * (0.7 + Math.random() * 0.6);
  return Math.min(Math.max(0, ms), MAX_WAIT_MS);
}

// seconds or an HTTP date
function retryAfterMs(value: string | null): number | undefined {
  if (value === null) return undefined;
  const ms = /^\d+$/.test(value.trim())
    ? Number(value.trim()) * 1000
    : Date.parse(value) - Date.now();
  return Number.isNaN(ms) ? undefined : ms;
}

// the global setTimeout, so a test clock can drive the wait
function wait(ms: number, signal: AbortSignal): Promise<void> {
  signal.throwIfAborted();
  const { promise, resolve, reject } = Promise.withResolvers<void>();
  const abort = (): void => {
    clearTimeout(timer);
    reject(signal.reason);
  };
  const timer = setTimeout(() => {
    signal.removeEventListener("abort", abort);
    resolve();
  }, ms);
  signal.addEventListener("abort", abort, { once: true });
  return promise;
}
